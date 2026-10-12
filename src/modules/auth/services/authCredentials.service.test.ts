import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it, TestContext } from 'node:test';
import { sequelize } from '../../../config/database.js';
import User from '../models/user.model.js';
import UserEmail from '../models/userEmail.model.js';
import RefreshToken from '../models/refreshToken.model.js';
import AccountActionToken from '../models/accountActionToken.model.js';
import { ACCOUNT_ACTION_TOKEN_TTL_MS, AccountActionTokenError, consumeAccountActionToken, issueAccountActionToken } from './accountActionToken.service.js';
import { rotateRefreshToken, revokeRefreshToken } from './refreshToken.service.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const row = (data: any): any => ({ get: (key: any) => typeof key === 'string' ? data[key] : { ...data },
    update: async (patch: any) => Object.assign(data, patch) });
function fixture(t: TestContext) {
    const tx = { LOCK: { UPDATE: 'UPDATE' } };
    const locks: string[] = [];
    const user: any = { id: 'user', email: 'user@example.invalid', isActive: true, authVersion: 0, password: 'old-hash' };
    const action: any = { userId: 'user', tokenHash: hash('a'.repeat(64)), purpose: 'reset_password',
        normalizedEmail: user.email, expiresAt: new Date(Date.now() + 100000), consumedAt: null, invalidatedAt: null };
    const refresh: any = { userId: 'user', familyId: 'family', authVersion: 0, tenantId: 'tenant',
        actor: 'staff', expiresAt: new Date(Date.now() + 100000), revokedAt: null, revokedReason: null };
    t.mock.method(sequelize, 'transaction', (async (callback: any) => callback(tx)) as any);
    t.mock.method(User, 'findByPk', (async (_id: any, options: any) => {
        if (options?.lock) locks.push('user'); return row(user);
    }) as any);
    t.mock.method(UserEmail, 'findOne', (async () => null) as any);
    t.mock.method(AccountActionToken, 'findOne', (async (options: any) => {
        if (options?.lock) locks.push('action');
        return Object.entries(options.where).every(([key, value]) => action[key] === value) ? row(action) : null;
    }) as any);
    t.mock.method(AccountActionToken, 'update', (async () => [1]) as any);
    const revocations = t.mock.method(RefreshToken, 'update', (async () => [1]) as any);
    t.mock.method(RefreshToken, 'findOne', (async (options: any) => {
        if (options?.lock) locks.push('refresh'); return row(refresh);
    }) as any);
    const emissions = t.mock.method(RefreshToken, 'create', (async (data: any) => row(data)) as any);
    const req: any = { get: () => undefined, ip: '127.0.0.1' };
    return { user, action, refresh, revocations, emissions, locks, req, tx };
}

it('issues random 256-bit scoped links, stores only a SHA-256 hash, and retains the 12h TTL', async t => {
    const records: any[] = [];
    t.mock.method(AccountActionToken, 'create', (async (data: any) => { records.push(data); return row(data); }) as any);
    const before = Date.now();
    const token = await issueAccountActionToken('user', ' User@Example.invalid ', 'verify_email');
    const other = await issueAccountActionToken('user', 'User@Example.invalid', 'reset_password');
    assert.match(token, /^[a-f0-9]{64}$/); assert.notEqual(token, other);
    assert.equal(records[0].tokenHash, hash(token)); assert.notEqual(records[0].tokenHash, token);
    assert.equal(records[0].purpose, 'verify_email'); assert.equal(records[1].purpose, 'reset_password');
    assert.equal(records[0].normalizedEmail, 'user@example.invalid');
    assert.ok(records[0].expiresAt.getTime() >= before + ACCOUNT_ACTION_TOKEN_TTL_MS);
    assert.equal(JSON.stringify(records).includes(token), false);
});
it('legacy JWT links are rejected before any database lookup', async t => {
    const query = t.mock.method(AccountActionToken, 'findOne', (async () => assert.fail('must not query')) as any);
    await assert.rejects(consumeAccountActionToken('eyJ.invalid.legacy', 'reset_password', 'new-hash'), AccountActionTokenError);
    assert.equal(query.mock.callCount(), 0);
});
it('verification links cannot reset passwords, and reset links cannot activate accounts', async t => {
    const { action, user } = fixture(t);
    await assert.rejects(consumeAccountActionToken('a'.repeat(64), 'verify_email'), AccountActionTokenError);
    action.purpose = 'verify_email';
    await assert.rejects(consumeAccountActionToken('a'.repeat(64), 'reset_password', 'new-hash'), AccountActionTokenError);
    assert.equal(user.password, 'old-hash'); assert.equal(action.consumedAt, null);
});
it('rejects expired, consumed, invalidated and reassigned-email links without changing the identity', async t => {
    const { action, user } = fixture(t);
    for (const patch of [{ expiresAt: new Date(0) }, { expiresAt: new Date(Date.now() + 10000), consumedAt: new Date() },
        { consumedAt: null, invalidatedAt: new Date() }, { invalidatedAt: null, normalizedEmail: 'changed@example.invalid' }]) {
        Object.assign(action, patch);
        await assert.rejects(consumeAccountActionToken('a'.repeat(64), 'reset_password', 'new-hash'), AccountActionTokenError);
    }
    assert.equal(user.password, 'old-hash'); assert.equal(user.authVersion, 0);
});
it('reset consumes once, increments version, preserves verification/suspension and revokes in the same transaction', async t => {
    const { action, user, revocations, locks, tx } = fixture(t);
    user.isActive = false; user.deactivatedAt = new Date();
    await consumeAccountActionToken('a'.repeat(64), 'reset_password', 'new-hash');
    assert.deepEqual(locks, ['user', 'action']);
    assert.equal(user.password, 'new-hash'); assert.equal(user.authVersion, 1); assert.equal(user.isActive, false);
    assert.ok(user.deactivatedAt); assert.ok(action.consumedAt);
    assert.equal((revocations.mock.calls[0].arguments[1] as any).transaction, tx);
    await assert.rejects(consumeAccountActionToken('a'.repeat(64), 'reset_password', 'another-hash'), AccountActionTokenError);
    assert.equal(user.password, 'new-hash');
});
it('verification consumes once, activates email and preserves suspension/password/version', async t => {
    const { action, user } = fixture(t); action.purpose = 'verify_email'; user.isActive = false; user.deactivatedAt = new Date();
    await consumeAccountActionToken('a'.repeat(64), 'verify_email');
    assert.equal(user.isActive, true); assert.ok(user.deactivatedAt); assert.equal(user.authVersion, 0);
    assert.equal(user.password, 'old-hash');
    await assert.rejects(consumeAccountActionToken('a'.repeat(64), 'verify_email'), AccountActionTokenError);
});
it('refresh grace checks expiry before minting and cannot revive pre-reset sessions', async t => {
    const { user, refresh, req, emissions } = fixture(t);
    refresh.revokedAt = new Date(); refresh.revokedReason = 'rotated'; refresh.expiresAt = new Date(0);
    assert.deepEqual(await rotateRefreshToken(req, 'token'), { ok: false, reason: 'expired' });
    refresh.expiresAt = new Date(Date.now() + 100000); user.authVersion = 1;
    assert.deepEqual(await rotateRefreshToken(req, 'token'), { ok: false, reason: 'invalid_session' });
    assert.equal(emissions.mock.callCount(), 0);
});
it('valid refresh grace retains the credential version and uses the shared User-before-token lock order', async t => {
    const { user, refresh, req, emissions, locks, tx } = fixture(t);
    user.authVersion = 3; refresh.authVersion = 3; refresh.revokedAt = new Date(); refresh.revokedReason = 'rotated';
    const result = await rotateRefreshToken(req, 'token');
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.equal(result.authVersion, 3); assert.deepEqual(locks, ['user', 'refresh']);
    assert.equal((emissions.mock.calls[0].arguments[0] as any).authVersion, 3);
    assert.equal((emissions.mock.calls[0].arguments[1] as any).transaction, tx);
});
it('explicit revocations never use grace and logout closes all predecessors of only that session family', async t => {
    const { refresh, req, emissions, revocations } = fixture(t);
    refresh.revokedAt = new Date(); refresh.revokedReason = 'logout';
    assert.deepEqual(await rotateRefreshToken(req, 'token'), { ok: false, reason: 'reused' });
    assert.equal(emissions.mock.callCount(), 0);
    await revokeRefreshToken('token');
    const options = revocations.mock.calls.at(-1)!.arguments[1] as any;
    assert.deepEqual(options.where, { familyId: 'family' });
});

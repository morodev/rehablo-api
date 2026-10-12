import assert from 'node:assert/strict';
import { it } from 'node:test';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';

it('PostgreSQL account grants and session revocation', { timeout: 120000 }, async t => {
    // Mandatory dedicated-database guard before importing anything using config/database.
    const { requireActivitiesTestDatabase } = await import('../../../../scripts/activities-test-database.mjs');
    const safeDatabase = requireActivitiesTestDatabase(process.env);
    process.env.DATABASE_URL = safeDatabase.databaseUrl;
    process.env.DB_SSL = 'false';
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = randomBytes(32).toString('hex');
    const { sequelize } = await import('../../../config/database.js');
    (sequelize as any).options.logging = false;
    const { default: User } = await import('../models/user.model.js');
    const { default: UserEmail } = await import('../models/userEmail.model.js');
    const { default: RefreshToken } = await import('../models/refreshToken.model.js');
    const { default: ActionToken } = await import('../models/accountActionToken.model.js');
    const { issueAccountActionToken, consumeAccountActionToken, AccountActionTokenError } = await import('../services/accountActionToken.service.js');
    const { issueRefreshToken, rotateRefreshToken, revokeRefreshToken } = await import('../services/refreshToken.service.js');
    const { AuthStateError, resolveApplicationPrincipal } = await import('../services/authState.service.js');
    const { migrateAuthSecurity } = await import('../services/authSecurityMigration.service.js');
    const require = createRequire(import.meta.url);
    const migration = require('../../../../migrations/20261012-auth-security-public.js');
    const userIds: string[] = [];
    const req: any = { get: () => 'auth-security-integration', ip: '127.0.0.1' };
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    async function identity(patch: any = {}) {
        const id = randomUUID(); userIds.push(id);
        return User.create({ id, email: `${id}@auth-security.invalid`, password: 'old-password-hash',
            isActive: true, isSuperAdmin: true, ...patch });
    }
    const claims = (user: any, patch: any = {}): any => ({ id: user.id, sub: user.id, email: user.email,
        actor: 'staff', isActive: true, isSuperAdmin: true, tenants: [], tokenUse: 'application', ...patch });
    const actionRecord = (token: string) => ActionToken.findOne({ where: { tokenHash: hash(token) }, rejectOnEmpty: true });

    let verified = false;
    try {
        const [databaseRows] = await sequelize.query('SELECT current_database() AS name');
        assert.equal((databaseRows[0] as any).name, safeDatabase.databaseName);
        verified = true;
        // No global bootstrap, provider connection, tenant synchronization or force sync.
        for (const model of [User, UserEmail, RefreshToken] as any[]) await model.sync({ force: false, alter: false });
        await migrateAuthSecurity();

        await t.test('public migration is repeatable and preserves existing owner and version values', async () => {
            const user = await identity({ authVersion: 4 });
            await migrateAuthSecurity(); await migrateAuthSecurity();
            await user.reload(); assert.equal(user.authVersion, 4); assert.equal(user.isSuperAdmin, true);
            const [rows] = await sequelize.query(`SELECT count(*)::int AS count FROM public.auth_security_migrations WHERE version = :version`,
                { replacements: { version: migration.VERSION } });
            assert.equal((rows[0] as any).count, 1);
            const [indexes] = await sequelize.query(`SELECT count(*)::int AS count FROM pg_indexes
                WHERE schemaname='public' AND tablename='account_action_tokens' AND indexname='account_action_tokens_hash_uq'`);
            assert.equal((indexes[0] as any).count, 1);
        });

        await t.test('legacy columns and a fresh action table migrate with version zero; fixture DDL rolls back', async () => {
            const user = await identity();
            const rollback = new Error('rollback isolated migration fixture');
            await assert.rejects(sequelize.transaction(async transaction => {
                // Only this guarded, dedicated test database; all DDL is rolled back atomically.
                await sequelize.query('DROP TABLE public.account_action_tokens', { transaction });
                await sequelize.query('ALTER TABLE public.users DROP COLUMN "authVersion"', { transaction });
                await sequelize.query('ALTER TABLE public.refresh_tokens DROP COLUMN "authVersion"', { transaction });
                await migration.up(sequelize.getQueryInterface(), { transaction });
                await migration.up(sequelize.getQueryInterface(), { transaction });
                const migrated = await User.findByPk(user.id, { transaction, rejectOnEmpty: true });
                assert.equal(migrated.authVersion, 0); assert.equal(migrated.isSuperAdmin, true);
                assert.equal(await ActionToken.count({ transaction }), 0);
                throw rollback;
            }), error => error === rollback);
            await user.reload(); assert.equal(user.authVersion, 0);
        });

        await t.test('concurrent consumption of one reset grant succeeds exactly once', async () => {
            const user = await identity();
            const token = await issueAccountActionToken(user.id, user.email, 'reset_password');
            const results = await Promise.allSettled([
                consumeAccountActionToken(token, 'reset_password', 'hash-one'),
                consumeAccountActionToken(token, 'reset_password', 'hash-two')
            ]);
            assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
            const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
            assert.ok(rejected.reason instanceof AccountActionTokenError);
            await user.reload(); assert.equal(user.authVersion, 1); assert.ok(['hash-one', 'hash-two'].includes(user.password));
            assert.ok((await actionRecord(token)).consumedAt);
        });

        await t.test('purpose separation, one-time email verification and suspension are enforced in stored state', async () => {
            const user = await identity({ isActive: false, deactivatedAt: new Date() });
            const verify = await issueAccountActionToken(user.id, user.email, 'verify_email');
            const reset = await issueAccountActionToken(user.id, user.email, 'reset_password');
            await assert.rejects(consumeAccountActionToken(verify, 'reset_password', 'bad'), AccountActionTokenError);
            await assert.rejects(consumeAccountActionToken(reset, 'verify_email'), AccountActionTokenError);
            const results = await Promise.allSettled([consumeAccountActionToken(verify, 'verify_email'), consumeAccountActionToken(verify, 'verify_email')]);
            assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
            await user.reload(); assert.equal(user.isActive, true); assert.ok(user.deactivatedAt); assert.equal(user.password, 'old-password-hash');
        });

        await t.test('reset invalidates other reset grants, legacy application JWTs and rotated refresh grace', async () => {
            const user = await identity();
            const first = await issueAccountActionToken(user.id, user.email, 'reset_password');
            const second = await issueAccountActionToken(user.id, user.email, 'reset_password');
            const oldRefresh = await issueRefreshToken(req, user.id, { authVersion: 0 });
            const rotation = await rotateRefreshToken(req, oldRefresh.token); assert.equal(rotation.ok, true);
            assert.equal((await resolveApplicationPrincipal(claims(user))).authVersion, 0);
            await consumeAccountActionToken(first, 'reset_password', 'new-hash');
            await assert.rejects(consumeAccountActionToken(second, 'reset_password', 'bad'), AccountActionTokenError);
            assert.ok((await actionRecord(second)).invalidatedAt);
            await assert.rejects(resolveApplicationPrincipal(claims(user)), AuthStateError);
            assert.deepEqual(await rotateRefreshToken(req, oldRefresh.token), { ok: false, reason: 'invalid_session' });
            if (rotation.ok) assert.deepEqual(await rotateRefreshToken(req, rotation.refresh.token), { ok: false, reason: 'invalid_session' });
            await user.reload();
            assert.equal((await resolveApplicationPrincipal(claims(user, { authVersion: 1 }))).authVersion, 1);
        });

        await t.test('concurrent reset and refresh leave no usable session authorized by the old credential', async () => {
            const user = await identity();
            const token = await issueAccountActionToken(user.id, user.email, 'reset_password');
            const oldRefresh = await issueRefreshToken(req, user.id, { authVersion: 0 });
            const [resetResult, rotated] = await Promise.all([
                consumeAccountActionToken(token, 'reset_password', 'new-hash'), rotateRefreshToken(req, oldRefresh.token)
            ]);
            assert.equal(resetResult, undefined); await user.reload(); assert.equal(user.authVersion, 1);
            assert.equal((await rotateRefreshToken(req, oldRefresh.token)).ok, false);
            if (rotated.ok) {
                assert.equal(rotated.authVersion, 0);
                assert.equal((await rotateRefreshToken(req, rotated.refresh.token)).ok, false);
            }
            assert.equal(await RefreshToken.count({ where: { userId: user.id, revokedAt: null } }), 0);
        });

        await t.test('failure while revoking sessions rolls back password, version and token consumption', async context => {
            const user = await identity();
            const token = await issueAccountActionToken(user.id, user.email, 'reset_password');
            const failure = new Error('injected refresh revocation failure');
            context.mock.method(RefreshToken, 'update', (async () => { throw failure; }) as any);
            await assert.rejects(consumeAccountActionToken(token, 'reset_password', 'bad'), error => error === failure);
            await user.reload(); assert.equal(user.password, 'old-password-hash'); assert.equal(user.authVersion, 0);
            assert.equal((await actionRecord(token)).consumedAt, null);
        });

        await t.test('failure while issuing a successor rolls back refresh rotation', async context => {
            const user = await identity(); const token = await issueRefreshToken(req, user.id, { authVersion: 0 });
            const failure = new Error('injected refresh create failure');
            context.mock.method(RefreshToken, 'create', (async () => { throw failure; }) as any);
            await assert.rejects(rotateRefreshToken(req, token.token), error => error === failure);
            const stored = await RefreshToken.findOne({ where: { tokenHash: hash(token.token) }, rejectOnEmpty: true });
            assert.equal(stored.revokedAt, null);
        });

        await t.test('expired rotated tokens are denied and logout closes grace for only its own family', async () => {
            const user = await identity();
            const current = await issueRefreshToken(req, user.id, { authVersion: 0 });
            const otherDevice = await issueRefreshToken(req, user.id, { authVersion: 0 });
            const rotated = await rotateRefreshToken(req, current.token); assert.equal(rotated.ok, true);
            await RefreshToken.update({ expiresAt: new Date(0) }, { where: { tokenHash: hash(current.token) } });
            assert.deepEqual(await rotateRefreshToken(req, current.token), { ok: false, reason: 'expired' });
            if (rotated.ok) await revokeRefreshToken(rotated.refresh.token);
            assert.equal(await RefreshToken.count({ where: { familyId: current.familyId, revokedAt: null } }), 0);
            assert.equal((await rotateRefreshToken(req, otherDevice.token)).ok, true);
        });
    } finally {
        if (verified && userIds.length) {
            await ActionToken.destroy({ where: { userId: userIds } });
            await RefreshToken.destroy({ where: { userId: userIds } });
            await UserEmail.destroy({ where: { userId: userIds } });
            await User.destroy({ where: { id: userIds } });
        }
        await sequelize.close();
    }
});

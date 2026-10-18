import {BillingAccount} from '../../billing/models/billing.model.js';
import assert from 'node:assert/strict';
import { it, TestContext } from 'node:test';
import { createServer, request } from 'node:http';
import { AddressInfo } from 'node:net';
import { once } from 'node:events';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from '../../../config/env.js';
import { requireAuth } from '../../../middleware/auth.js';
import { login, loginPremise, loginWithToken, refresh } from './auth.controller.js';
import { selectSessionContext } from './session.controller.js';
import { PatientPortalAccess, Structure, StructureUser, StructureUserAvailability, Tenant, TenantUser, User } from '../models/index.js';
import RefreshToken from '../models/refreshToken.model.js';
import { sequelize } from '../../../config/database.js';
import { getRolePermissions, RoleCode } from '../rbac/roles.js';
import { signApplicationToken } from '../services/applicationToken.service.js';

const id = (number: number) => 'cccccccc-cccc-4ccc-8ccc-' + String(number).padStart(12, '0');
const userId = id(1), tenantId = id(2), structureId = id(3);
const record = (data: any): any => ({...data,
    get: (key: any) => typeof key === 'string' ? data[key] : {...data},
    update: async (patch: any) => Object.assign(data, patch)});
function run(handler: any, req: any): Promise<any> {
    return new Promise(resolve => {
        const res: any = {statusCode: 200, status(code: number) {this.statusCode = code; return this;},
            json(body: any) {resolve({status: this.statusCode, body}); return this;}};
        handler(req, res, (error: any) => resolve({status: 500, error}));
    });
}
function fixture(t: TestContext) {
    t.mock.method(BillingAccount, 'findByPk', (async () => null) as any);
    t.mock.method(sequelize, 'transaction', (async (callback: any) => callback({ LOCK: { UPDATE: 'UPDATE' } })) as any);
    const structure = {id: structureId, tenantId, name: 'Test site'};
    const calendar = {userId, structureId, calendarEnabled: true, availabilityMode: 'CUSTOM', role: null};
    const rows = Array.from({length: 7}, (_, day) => ({id: id(day + 10), userId, structureId, day, enabled: day === 0,
        rangeOneStart: day === 0 ? '09:00:00' : null, rangeOneFinish: day === 0 ? '12:00:00' : null,
        rangeTwoStart: null, rangeTwoFinish: null, rangeThreeStart: null, rangeThreeFinish: null,
        rangeFourStart: null, rangeFourFinish: null, createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z'}));
    const identity = {id: userId, email: 'fixture@example.invalid', name: 'Fixture', surname: 'User',
        password: bcrypt.hashSync('fixture-password', 4), isActive: true, isSuperAdmin: false, deactivatedAt: null,
        structures: [structure], tenants: [{id: tenantId}]};
    const membership = {tenantId, userId, role: RoleCode.OWNER, deactivatedAt: null};
    t.mock.method(User, 'findOne', (async () => record(identity)) as any);
    t.mock.method(User, 'findByPk', (async () => record(identity)) as any);
    t.mock.method(TenantUser, 'findOne', (async () => record(membership)) as any);
    t.mock.method(Tenant, 'findByPk', (async () => record({id: tenantId})) as any);
    t.mock.method(Structure, 'findByPk', (async () => record(structure)) as any);
    t.mock.method(Structure, 'findOne', (async () => record(structure)) as any);
    t.mock.method(Structure, 'findAll', (async () => [record(structure)]) as any);
    t.mock.method(StructureUser, 'findOne', (async () => record(calendar)) as any);
    t.mock.method(StructureUser, 'findAll', (async () => [record(calendar)]) as any);
    t.mock.method(StructureUserAvailability, 'findAll', (async () => rows.map(record)) as any);
    t.mock.method(PatientPortalAccess, 'findOne', (async () => record({id: id(8), userId, tenantId, patientId: id(9), status: 'ACTIVE'})) as any);
    t.mock.method(RefreshToken, 'create', (async (value: any) => record(value)) as any);
    t.mock.method(RefreshToken, 'update', (async () => [1]) as any);
    t.mock.method(RefreshToken, 'findOne', (async () => record({userId, tenantId, structureId, actor: 'staff',
        familyId: id(7), revokedAt: null, expiresAt: new Date(Date.now() + 3600000)})) as any);
    const req: any = {body: {}, params: {premiseId: structureId}, user: {id: userId, sub: userId, email: identity.email, tid: tenantId},
        get: () => 'header-regression-test', ip: '127.0.0.1', socket: {remoteAddress: '127.0.0.1'}};
    const claims = {...identity, password: undefined, sub: userId, actor: 'staff', tokenUse: 'application',
        tid: tenantId, sid: structureId, role: RoleCode.OWNER, perms: getRolePermissions(RoleCode.OWNER), selectedPremise: structure};
    return {req, rows, calendar, claims};
}
function assertCalendarOutsideJwt(result: any, selected: boolean): any {
    assert.equal(result.status, 200, result.error?.message);
    const data = result.body.data ?? result.body;
    const decoded = jwt.verify(data.accessToken, env.jwtSecret) as any;
    for (const field of ['calendarEnabled', 'availabilityMode', 'userAvailabilities']) assert.equal(Object.hasOwn(decoded, field), false);
    assert.equal(decoded.role, RoleCode.OWNER);
    assert.equal(decoded.tid, tenantId);
    assert.equal(decoded.sid, selected ? structureId : null);
    assert.equal(data.user.calendarEnabled, selected);
    assert.equal(data.user.availabilityMode, selected ? 'CUSTOM' : 'INHERIT_STRUCTURE');
    assert.equal(data.user.userAvailabilities.length, selected ? 7 : 0);
    if (selected) assert.equal(data.user.userAvailabilities[0].rangeOneStart, '09:00:00');
    return decoded;
}

it('login keeps the current calendar profile in its response, outside authentication claims', async t => {
    const {req} = fixture(t); req.body = {email: 'fixture@example.invalid', password: 'fixture-password'};
    assertCalendarOutsideJwt(await run(login, req), false);
});
it('premise selection returns scoped custom hours while signing a smaller token', async t => {
    const {req} = fixture(t);
    assertCalendarOutsideJwt(await run(loginPremise, req), true);
});
it('refresh keeps saved premise and permissions and returns the scoped schedule outside the token', async t => {
    const {req} = fixture(t); req.body = {refreshToken: 'fixture-refresh-token'};
    assertCalendarOutsideJwt(await run(refresh, req), true);
});
it('staff context selection uses the same token policy and keeps calendar profile response fields', async t => {
    const {req} = fixture(t);
    req.body = {selectionToken: jwt.sign({sub: userId, tokenUse: 'context_selection'}, env.jwtSecret, {expiresIn: '5m'}),
        contextId: 'staff:' + tenantId};
    assertCalendarOutsideJwt(await run(selectSessionContext, req), false);
});
it('patient context selection preserves its principal and excludes calendar fields from the JWT', async t => {
    const {req} = fixture(t);
    req.body = {selectionToken: jwt.sign({sub: userId, tokenUse: 'context_selection'}, env.jwtSecret, {expiresIn: '5m'}),
        contextId: 'patient:' + id(8)};
    const result = await run(selectSessionContext, req);
    assert.equal(result.status, 200);
    const decoded = jwt.verify(result.body.data.accessToken, env.jwtSecret) as any;
    assert.equal(decoded.actor, 'patient'); assert.equal(decoded.role, 'PATIENT'); assert.equal(decoded.pid, id(9));
    assert.equal(Object.hasOwn(decoded, 'userAvailabilities'), false);
    assert.equal(result.body.data.user.calendarEnabled, false);
});
it('restoring an existing token preserves expiry and permissions while returning current calendar data', async t => {
    const {req, rows, claims} = fixture(t);
    const now = Math.floor(Date.now() / 1000);
    req.body = {accessToken: jwt.sign({...claims, iat: now - 300, exp: now + 120, calendarEnabled: true,
        availabilityMode: 'CUSTOM', userAvailabilities: rows}, env.jwtSecret)};
    const original = jwt.verify(req.body.accessToken, env.jwtSecret) as any;
    const decoded = assertCalendarOutsideJwt(await run(loginWithToken, req), true);
    assert.equal(decoded.exp, original.exp); assert.equal(decoded.iat, original.iat); assert.deepEqual(decoded.perms, original.perms);
});
it('token restoration verifies signature and expiry before returning a replacement', async t => {
    const {req, claims} = fixture(t);
    for (const token of [jwt.sign(claims, 'wrong-fixture-secret'), jwt.sign({...claims, exp: 1}, env.jwtSecret)]) {
        req.body = {accessToken: token};
        const result = await run(loginWithToken, req);
        assert.equal(result.status, 401);
    }
});

it('recovers an oversized JWT through the body and restores normal HTTP header acceptance', async t => {
    const {rows, claims} = fixture(t);
    const oldToken = jwt.sign({...claims, metadata: 'x'.repeat(9000), calendarEnabled: true,
        availabilityMode: 'CUSTOM', userAvailabilities: rows}, env.jwtSecret, {expiresIn: '5m'});
    assert.ok(Buffer.byteLength(oldToken) > 16384);
    const app = express(); app.use(express.json());
    app.post('/auth/login-token', loginWithToken);
    app.get('/protected', requireAuth, (_req, res) => res.json({ok: true}));
    const server = createServer(app);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const send = (method: string, path: string, accessToken?: string, body?: any): Promise<any> => new Promise((resolve, reject) => {
        const encoded = body === undefined ? undefined : JSON.stringify(body);
        const call = request({hostname: '127.0.0.1', port, method, path, headers: {
            ...(accessToken ? {Authorization: 'Bearer ' + accessToken} : {}),
            ...(encoded ? {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded)} : {})
        }}, response => {
            let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk);
            response.on('end', () => resolve({status: response.statusCode, body: text ? JSON.parse(text) : null}));
        });
        call.on('error', reject); call.end(encoded);
    });
    try {
        assert.equal((await send('GET', '/protected', oldToken)).status, 431);
        const restored = await send('POST', '/auth/login-token', undefined, {accessToken: oldToken});
        const compact = restored.body.accessToken;
        assert.equal(restored.status, 200); assert.ok(Buffer.byteLength(compact) < 14000);
        assert.equal((await send('GET', '/protected', compact)).status, 200);
        assert.equal(restored.body.user.userAvailabilities.length, 7);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('restores the profile and site selector from a compact token without profile claims', async t => {
    const {req, claims} = fixture(t);
    req.body = {accessToken: signApplicationToken(claims)};
    const tokenClaims = jwt.verify(req.body.accessToken, env.jwtSecret) as any;
    assert.equal(Object.hasOwn(tokenClaims, 'name'), false);
    assert.equal(Object.hasOwn(tokenClaims, 'structures'), false);
    const result = await run(loginWithToken, req);
    assertCalendarOutsideJwt(result, true);
    assert.equal(result.body.user.name, 'Fixture');
    assert.equal(result.body.user.surname, 'User');
    assert.equal(result.body.user.selectedPremise.name, 'Test site');
    assert.equal(result.body.user.structures[0].id, structureId);
    assert.equal(result.body.user.data.structures[0].name, 'Test site');
    assert.equal(Object.hasOwn(result.body.user.data, 'password'), false);
});

import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {createActivitiesHarness, type ActivitiesHarness} from './activitiesTestHarness.js';

let harness: ActivitiesHarness;
const password = 'Activities-test-only-password';
before(async () => {harness = await createActivitiesHarness();
    await harness.auth.User.update({password: await bcrypt.hash(password, 4)}, {where: {id: harness.ids.ownerA}});
});
after(async () => {if (harness) {
    const {default: RefreshToken} = await import('../../auth/models/refreshToken.model.js');
    await RefreshToken.destroy({where: {userId: harness.ids.ownerA}}); await harness.cleanup();
}});

async function request(method: string, path: string, body?: unknown, token?: string) {
    const response = await fetch(harness.baseUrl + path, {method,
        headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})},
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000)});
    return {status: response.status, body: await response.json() as any};
}
async function startSession() {
    const user = await harness.auth.User.findByPk(harness.ids.ownerA);
    const response = await request('POST', '/auth/session', {email: user!.get('email'), password});
    assert.equal(response.status, 200); return response.body.data;
}
test('login, scelta contesto, sede e profilo mantengono accesso alla bacheca', async () => {
    const session = await startSession();
    assert.ok(session.contexts.some((context: any) => context.id === `staff:${harness.ids.tenantA}`));
    const selected = await request('POST', '/auth/session/context', {selectionToken: session.selectionToken, contextId: `staff:${harness.ids.tenantA}`});
    assert.equal(selected.status, 200); assert.equal(selected.body.data.user.structures.length, 2);
    const premise = await request('POST', `/auth/login-premise/${harness.ids.structureA}`, {refreshToken: selected.body.data.refreshToken}, selected.body.data.accessToken);
    assert.equal(premise.status, 200); const token = premise.body.data.accessToken;
    const profile = await request('GET', '/auth/me', undefined, token);
    assert.equal(profile.status, 200); assert.equal(profile.body.data.structureId, harness.ids.structureA);
    assert.ok(profile.body.data.permissions.some((permission: string) => permission.startsWith('activity:')));
    const board = await request('GET', '/activities/board', undefined, token);
    assert.equal(board.status, 200); assert.equal(board.body.data.structureId, harness.ids.structureA);
});
test('selectionToken scaduto restituisce 401 e una sessione valida permette di rigenerarlo', async () => {
    const session = await startSession();
    const selected = await request('POST', '/auth/session/context', {selectionToken: session.selectionToken, contextId: `staff:${harness.ids.tenantA}`});
    const expired = jwt.sign({sub: harness.ids.ownerA, tokenUse: 'context_selection', exp: Math.floor(Date.now()/1000)-60}, process.env.JWT_SECRET!);
    const failure = await request('POST', '/auth/session/context', {selectionToken: expired, contextId: `staff:${harness.ids.tenantA}`});
    assert.equal(failure.status, 401); assert.match(failure.body.message, /scaduta/);
    const refreshed = await request('GET', '/auth/session/contexts', undefined, selected.body.data.accessToken);
    assert.equal(refreshed.status, 200);
    const recovered = await request('POST', '/auth/session/context', {selectionToken: refreshed.body.data.selectionToken, contextId: `staff:${harness.ids.tenantA}`});
    assert.equal(recovered.status, 200);
});
test('contesto di un centro estraneo restituisce 403 senza alterare le assegnazioni', async () => {
    const session = await startSession();
    const failure = await request('POST', '/auth/session/context', {selectionToken: session.selectionToken, contextId: `staff:${harness.ids.tenantB}`});
    assert.equal(failure.status, 403);
    assert.equal(await harness.auth.StructureUser.count({where: {userId: harness.ids.ownerA}}), 2);
});

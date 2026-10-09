import assert from 'node:assert/strict';
import { it } from 'node:test';
import jwt from 'jsonwebtoken';
import { env } from '../../../config/env.js';
import { compactVerifiedApplicationToken, signApplicationToken } from './applicationToken.service.js';

const schedule = Array.from({length: 7}, (_, day) => ({day, enabled: true, notes: 'x'.repeat(600)}));
const identity = {id: 'user', sub: 'user', tid: 'tenant', sid: 'site', role: 'OWNER',
    perms: ['agenda:read:structure'], isSuperAdmin: false, selectedPremise: {id: 'site'}};

for (const actor of ['staff', 'patient']) {
    it('keeps calendar response data outside the ' + actor + ' JWT without mutating its source', () => {
        const payload = {...identity, actor, patientAccessId: actor === 'patient' ? 'access' : undefined,
            calendarEnabled: true, availabilityMode: 'CUSTOM', userAvailabilities: schedule};
        const original = JSON.stringify(payload);
        const decoded = jwt.verify(signApplicationToken(payload), env.jwtSecret) as any;
        assert.equal(JSON.stringify(payload), original);
        for (const field of ['calendarEnabled', 'availabilityMode', 'userAvailabilities']) {
            assert.equal(Object.hasOwn(decoded, field), false);
        }
        assert.equal(decoded.actor, actor);
        assert.equal(decoded.tokenUse, 'application');
        assert.deepEqual(decoded.perms, identity.perms);
        assert.deepEqual(decoded.selectedPremise, identity.selectedPremise);
        assert.equal(decoded.tid, identity.tid);
        assert.equal(decoded.sid, identity.sid);
    });
}

it('compacts a verified existing session without extending expiration or changing claims', () => {
    const now = Math.floor(Date.now() / 1000);
    const oldToken = jwt.sign({...identity, actor: 'staff', tokenUse: 'application', iat: now - 300, exp: now + 90,
        calendarEnabled: true, availabilityMode: 'CUSTOM', userAvailabilities: schedule}, env.jwtSecret);
    const original = jwt.verify(oldToken, env.jwtSecret) as any;
    const compact = compactVerifiedApplicationToken(original);
    const decoded = jwt.verify(compact, env.jwtSecret) as any;
    const {calendarEnabled, availabilityMode, userAvailabilities, ...expected} = original;
    assert.deepEqual(decoded, expected);
    assert.ok(Buffer.byteLength(compact) < Buffer.byteLength(oldToken));
});

it('preserves the token purpose and legacy claims when compacting', () => {
    const token = jwt.sign({sub: 'user', tokenUse: 'context_selection', exp: Math.floor(Date.now() / 1000) + 90}, env.jwtSecret);
    const decoded = jwt.verify(token, env.jwtSecret) as any;
    assert.deepEqual(jwt.verify(compactVerifiedApplicationToken(decoded), env.jwtSecret), decoded);
});

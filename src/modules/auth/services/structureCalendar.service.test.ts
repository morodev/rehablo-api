import assert from 'node:assert/strict';
import { it, TestContext } from 'node:test';
import { Structure, StructureAvailability, StructureUser, StructureUserAvailability } from '../models/index.js';
import { defaultCalendarEnabled, projectStructureCalendars, saveStructureCalendar } from './structureCalendar.service.js';
import { RoleCode } from '../rbac/roles.js';

const transaction: any = {LOCK: {UPDATE: 'UPDATE'}};
const record = (data: any): any => ({...data, get: () => ({...data})});
function fixture(t: TestContext) {
    const members: any[] = [{userId: 'u', structureId: 'a', role: RoleCode.PHYSIATRIST, calendarEnabled: true, availabilityMode: 'CUSTOM'},
        {userId: 'u', structureId: 'b', role: null, calendarEnabled: false, availabilityMode: 'INHERIT_STRUCTURE'}];
    let rows: any[] = Array.from({length: 7}, (_, day) => ({userId: 'u', structureId: 'a', day, enabled: day === 0,
        rangeOneStart: day === 0 ? '09:00:00' : null, rangeOneFinish: day === 0 ? '12:00:00' : null}));
    const matches = (row: any, where: any) => row.structureId === where.structureId && (typeof where.userId !== 'string' || row.userId === where.userId);
    t.mock.method(Structure, 'findOne', (async ({where}: any) => where.tenantId === 'tenant' ? {id: where.id} : null) as any);
    t.mock.method(StructureUser, 'findOne', (async ({where}: any) => {
        const data = members.find(row => matches(row, where));
        return data ? {...data, update: async (patch: any) => Object.assign(data, patch)} : null;
    }) as any);
    t.mock.method(StructureUser, 'findAll', (async ({where}: any) => members.filter(row => matches(row, where))) as any);
    t.mock.method(StructureUserAvailability, 'findAll', (async ({where}: any) => rows.filter(row => matches(row, where)).map(record)) as any);
    t.mock.method(StructureUserAvailability, 'destroy', (async ({where}: any) => {rows = rows.filter(row => !matches(row, where)); return 7;}) as any);
    t.mock.method(StructureUserAvailability, 'bulkCreate', (async (input: any[]) => {rows.push(...input); return input;}) as any);
    t.mock.method(StructureAvailability, 'findAll', (async () => [record({day: 0, enabled: true, open: '08:00:00', close: '18:00:00'})]) as any);
    return {members, rows: () => rows};
}
it('new owners and secretaries start without agenda while operators start enabled', () => {
    assert.equal(defaultCalendarEnabled(RoleCode.OWNER), false);
    assert.equal(defaultCalendarEnabled(RoleCode.SECRETARY), false);
    assert.equal(defaultCalendarEnabled(RoleCode.THERAPIST), true);
    const newOwnerAssignment = StructureUser.build({userId: 'u', structureId: 'new-site', role: null});
    assert.equal(newOwnerAssignment.calendarEnabled, false);
    assert.equal(newOwnerAssignment.availabilityMode, 'INHERIT_STRUCTURE');
});
it('projects only the selected structure and never falls back to global or another tenant schedules', async t => {
    fixture(t);
    const user = {id: 'u', role: RoleCode.THERAPIST, calendarEnabled: true, availabilityMode: 'CUSTOM', userAvailabilities: [{day: 6, enabled: true}]};
    const [a] = await projectStructureCalendars([user], 'tenant', 'a');
    const [b] = await projectStructureCalendars([user], 'tenant', 'b');
    const [foreign] = await projectStructureCalendars([user], 'other-tenant', 'a');
    assert.equal(a.calendarEnabled, true); assert.equal(a.userAvailabilities[0].rangeOneStart, '09:00:00');
    assert.equal(a.calendarRole, RoleCode.PHYSIATRIST);
    assert.equal(b.calendarEnabled, false); assert.equal(b.availabilityMode, 'INHERIT_STRUCTURE');
    assert.equal(b.calendarRole, RoleCode.THERAPIST);
    assert.equal(foreign.calendarEnabled, false); assert.deepEqual(foreign.userAvailabilities, []);
});
it('disabling preserves saved mode and ranges; reactivation restores them without affecting the other premise', async t => {
    const f = fixture(t); const oldRows = JSON.stringify(f.rows());
    await saveStructureCalendar('u', 'a', {calendarEnabled: false, availabilityMode: 'INHERIT_STRUCTURE'}, transaction);
    assert.equal(f.members[0].availabilityMode, 'CUSTOM'); assert.equal(f.members[0].calendarEnabled, false);
    assert.equal(JSON.stringify(f.rows()), oldRows);
    await saveStructureCalendar('u', 'a', {calendarEnabled: true}, transaction);
    assert.equal(f.members[0].calendarEnabled, true); assert.equal(f.members[0].availabilityMode, 'CUSTOM');
    assert.equal(f.rows()[0].rangeOneStart, '09:00:00'); assert.equal(f.members[1].calendarEnabled, false);
});
it('first enabling a premise inherits opening hours and ignores inactive draft rows', async t => {
    const f = fixture(t);
    await saveStructureCalendar('u', 'b', {availabilityMode: 'CUSTOM', userAvailabilities: [{day: 0}]}, transaction);
    assert.equal(f.members[1].availabilityMode, 'INHERIT_STRUCTURE');
    await saveStructureCalendar('u', 'b', {calendarEnabled: true, userAvailabilities: [{day: 0}]}, transaction);
    assert.equal(f.members[1].availabilityMode, 'INHERIT_STRUCTURE'); assert.equal(f.members[1].calendarEnabled, true);
    assert.equal(f.rows().filter(row => row.structureId === 'b').length, 0);
});
it('custom hours respect the selected premise opening and reject unknown memberships', async t => {
    const f = fixture(t);const invalid=f.rows().map(row => ({...row, rangeOneStart: row.enabled ? '07:00' : null}));
    await assert.rejects(saveStructureCalendar('u', 'a', {availabilityMode: 'CUSTOM', userAvailabilities: invalid}, transaction), /orario della sede/);
    await assert.rejects(saveStructureCalendar('u', 'missing', {calendarEnabled: true}, transaction), /non assegnato/);
    assert.equal(f.rows()[0].rangeOneStart,'09:00:00');
});

import assert from 'node:assert/strict';
import {test, TestContext} from 'node:test';
import {Op} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {Structure, StructureUser, TenantUser, User} from '../../auth/models/index.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import Patient from '../models/patient.model.js';
import {PatientContactFollowUp} from '../models/patientContactFollowUp.model.js';
import Reminder from '../../notes/models/reminder.model.js';
import ReminderAssignment from '../../notes/models/reminderAssignment.model.js';
import ReminderAlertState from '../../notes/models/reminderAlertState.model.js';
import {getPatientContactFollowUp, setPatientContactFollowUp} from './patientContactFollowUp.service.js';
import {claimReminderAlerts, completeReminder, getReminderById, getReminders, snoozeReminderAlert, updateReminder} from '../../notes/controllers/workItemReminder.controller.js';
import {completePatientContactReminders} from './patientContactCompletion.service.js';

type Row = Record<string, any>;
const [actor, patientId, site, eventId, other] = Array.from({length: 5}, (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, '0')}`);
const schema = 'rehablo_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa';
function matches(row: Row, where: any): boolean {
    return !where || Reflect.ownKeys(where).every(key => {
        const expected = where[key];
        if (key === Op.and) return expected.every((part: any) => matches(row, part));
        if (key === Op.or) return expected.some((part: any) => matches(row, part));
        if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
            if (Op.in in expected) return expected[Op.in].includes(row[key as string]);
            if (Op.between in expected) return row[key as string] >= expected[Op.between][0] && row[key as string] <= expected[Op.between][1];
            if (Op.lte in expected) return row[key as string] <= expected[Op.lte];
            if (Op.gte in expected) return row[key as string] >= expected[Op.gte];
        }
        return (row[key as string] ?? null) === expected;
    });
}
function fixture(t: TestContext) {
    t.mock.timers.enable({apis: ['Date'], now: new Date('2026-10-26T12:00:00Z')});
    const patients: Row[] = [{id: patientId, userId: actor, structureId: site, archivedAt: null, name: 'Mario', surname: 'Rossi', emails: [], phoneNumbers: []}];
    const preferences: Row[] = [], reminders: Row[] = [], assignments: Row[] = [], states: Row[] = [];
    const tables = [patients, preferences, reminders, assignments, states];
    const failure = {assignments: false};
    const locks = new Map<string, Promise<void>>(); let sequence = 0;
    async function lock(tx: any, key: string) {
        if (tx.held.has(key)) return;
        const pending = locks.get(key) ?? Promise.resolve(); let release!: () => void;
        const next = new Promise<void>(resolve => {release = resolve;}); locks.set(key, pending.then(() => next));
        await pending; tx.held.add(key); tx.releases.push(release);
    }
    function model(values: Row): any {
        const instance: any = {...values, get: (key: any) => typeof key === 'string' ? values[key] : {...values},
            update: async (changes: Row) => {Object.assign(values, changes); Object.assign(instance, changes); return instance;},
            destroy: async () => {const rows = tables.find(table => table.includes(values))!; rows.splice(rows.indexOf(values), 1);}};
        return instance;
    }
    function repository(rows: Row[], kind: string): any {
        const repo: any = {
            findAll: async (options: any = {}) => rows.filter(row => matches(row, options.where)).map(row => options.raw ? {...row} : model(row)),
            findOne: async (options: any = {}) => {if (options.lock) await lock(options.transaction, `${kind}:${options.where?.id ?? 'all'}`); const row = rows.find(row => matches(row, options.where)); return row ? model(row) : null;},
            findByPk: async (id: string, options: any = {}) => {if (options.lock) await lock(options.transaction, `${kind}:${id}`); const row = rows.find(row => row.id === id); return row ? model(row) : null;},
            create: async (values: Row) => {const row = {id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(++sequence).padStart(12, '0')}`, sourceType: null, ...values}; rows.push(row); return model(row);},
            findOrCreate: async (options: any) => {const found = await repo.findOne(options); return found ? [found, false] : [await repo.create(options.defaults), true];},
            update: async (values: Row, options: any) => {const matched = rows.filter(row => matches(row, options.where)); matched.forEach(row => Object.assign(row, values)); return [matched.length];},
            destroy: async (options: any) => {const removed = rows.filter(row => matches(row, options.where)); removed.forEach(row => rows.splice(rows.indexOf(row), 1)); return removed.length;},
            bulkCreate: async (values: Row[]) => {if (kind === 'assignment' && failure.assignments) throw new Error('assignment failed'); for (const row of values) if (!rows.some(existing => existing.reminderId === row.reminderId && existing.userId === row.userId)) rows.push({...row});}
        }; return repo;
    }
    for (const [entity, rows, kind] of [[Patient, patients, 'patient'], [PatientContactFollowUp, preferences, 'preference'], [Reminder, reminders, 'reminder'],
        [ReminderAssignment, assignments, 'assignment'], [ReminderAlertState, states, 'state']] as const) t.mock.method(entity, 'schema', (() => repository(rows, kind)) as any);
    t.mock.method(StructureUser, 'findAll', (async () => [{structureId: site, userId: actor, role: 'OWNER'}]) as any);
    t.mock.method(TenantUser, 'findAll', (async () => [{tenantId: actor, userId: actor, role: 'OWNER', deactivatedAt: null}]) as any);
    t.mock.method(User, 'findAll', (async () => [{id: actor, name: 'Operatore', surname: 'Test'}]) as any);
    t.mock.method(User, 'findByPk', (async () => ({id: actor, name: 'Operatore', surname: 'Test'})) as any);
    t.mock.method(Structure, 'findOne', (async () => ({id: site, name: 'Sede test'})) as any);
    t.mock.method(AgendaEvent, 'schema', (() => repository([{id: eventId, structureId: site, patientId, calendarId: actor, title: 'Seduta', start: '2026-10-27T10:00:00Z'}], 'event')) as any);
    t.mock.method(sequelize, 'query', (async (_sql: string, options: any) => {await lock(options.transaction, options.replacements.key); return [[], {}];}) as any);
    t.mock.method(sequelize, 'transaction', (async (run: any) => {
        const snapshots = tables.map(rows => structuredClone(rows));
        const tx = {LOCK: {UPDATE: 'UPDATE'}, held: new Set<string>(), releases: [] as Array<() => void>};
        try {return await run(tx);} catch (error) {tables.forEach((rows, i) => rows.splice(0, rows.length, ...snapshots[i])); throw error;} finally {tx.releases.forEach(release => release());}
    }) as any);
    const request = (body: Row = {}, params: Row = {patientId}): any => ({tenantSchema: schema, params, body, query: {},
        user: {sub: actor, tid: actor, sid: site, permissions: ['patient:read:structure', 'agenda:read:structure', 'reminder:read:own', 'reminder:create:own', 'reminder:update:own']},
        access: {scope: 'structure', structureId: site, userId: actor}});
    return {patients, preferences, reminders, assignments, states, request, failure};
}
function invoke(handler: any, req: any): Promise<{status: number; data: any}> {
    return new Promise((resolve, reject) => {
        const res: any = {code: 200, status(code: number) {this.code = code; return this;}, json(body: any) {resolve({status: this.code, data: body.data}); return this;}};
        handler(req, res, (error: any) => error?.statusCode ? resolve({status: error.statusCode, data: null}) : reject(error));
    });
}
test('suppression/reset are personal to the selected patient and site and preserve patient communication consent', async t => {
    const f = fixture(t); f.patients[0].whatsappNotificationsConsent = true;
    assert.equal((await setPatientContactFollowUp(f.request({action: 'suppress'}))).suppressed, true);
    const otherReq = f.request(); otherReq.user.sub = other; otherReq.access.userId = other;
    assert.equal((await getPatientContactFollowUp(otherReq)).suppressed, false);
    assert.equal((await setPatientContactFollowUp(f.request({action: 'reset'}))).suppressed, false);
    assert.equal(f.patients[0].whatsappNotificationsConsent, true); assert.equal(f.reminders.length, 0);
});
test('concurrent remind requests return one linked personal reminder due tomorrow 09 Rome', async t => {
    const f = fixture(t), req = f.request({action: 'remind', agendaEventId: eventId});
    const results = await Promise.all([setPatientContactFollowUp(req), setPatientContactFollowUp(req)]);
    assert.equal(results[0].reminder.id, results[1].reminder.id); assert.equal(f.reminders.length, 1); assert.equal(f.preferences.length, 1);
    assert.equal(f.reminders[0].title, 'Aggiungere recapiti per Mario Rossi');
    assert.equal(f.reminders[0].remindAt.toISOString(), '2026-10-27T08:00:00.000Z');
    assert.deepEqual(results[0].reminder.assignedUserIds, [actor]); assert.match(f.reminders[0].description, /Sede test/);
});
test('known valid contact prevents reminder creation, and permission/site failures are enforced by backend', async t => {
    const f = fixture(t); f.patients[0].emails = [{email: 'person@example.it'}];
    assert.equal((await setPatientContactFollowUp(f.request({action: 'remind'}))).hasUsableContact, true); assert.equal(f.reminders.length, 0);
    const denied = f.request({action: 'remind'}); denied.user.permissions = ['patient:read:structure'];
    await assert.rejects(setPatientContactFollowUp(denied), {statusCode: 403});
    const otherSite = f.request(); otherSite.access.structureId = other;
    await assert.rejects(getPatientContactFollowUp(otherSite), {statusCode: 404});
    f.patients[0].emails = [];
    await assert.rejects(setPatientContactFollowUp(f.request({action: 'remind', agendaEventId: other})), {statusCode: 404});
});
test('a failed assignment rolls back both preference and reminder creation', async t => {
    const f = fixture(t); f.failure.assignments = true;
    await assert.rejects(setPatientContactFollowUp(f.request({action: 'remind'})), /assignment failed/);
    assert.equal(f.preferences.length, 0); assert.equal(f.reminders.length, 0); assert.equal(f.assignments.length, 0);
});
test('claim deduplicates simultaneous tabs, repeats daily and stops after contact completion', async t => {
    const f = fixture(t); await setPatientContactFollowUp(f.request({action: 'remind'}));
    t.mock.timers.setTime(new Date('2026-10-27T10:00:00Z').getTime());
    const claims = await Promise.all([invoke(claimReminderAlerts, f.request()), invoke(claimReminderAlerts, f.request())]);
    assert.equal(claims.reduce((count, response) => count + response.data.length, 0), 1); assert.equal(f.states.length, 1);
    t.mock.timers.setTime(new Date('2026-10-28T10:00:00Z').getTime());
    assert.equal((await invoke(claimReminderAlerts, f.request())).data.length, 1);
    f.patients[0].phoneNumbers = [{phoneNumber: '3331234567', country: 'it'}];
    await completePatientContactReminders(schema, f.patients[0]);
    assert.equal((await invoke(claimReminderAlerts, f.request())).data.length, 0); assert.equal(f.reminders[0].status, 'DONE');
});
test('explicit snooze emits once at expiry and resumes the next day 09 without another same-day daily alert', async t => {
    const f = fixture(t); const result = await setPatientContactFollowUp(f.request({action: 'remind'}));
    assert.equal((await invoke(snoozeReminderAlert, f.request({snoozedUntil: '2026-10-26T14:00:00Z'}, {reminderId: result.reminder.id}))).status, 422);
    t.mock.timers.setTime(new Date('2026-10-27T10:00:00Z').getTime());
    await invoke(claimReminderAlerts, f.request());
    await invoke(snoozeReminderAlert, f.request({snoozedUntil: '2026-10-28T11:00:00Z'}, {reminderId: result.reminder.id}));
    t.mock.timers.setTime(new Date('2026-10-28T10:00:00Z').getTime());
    assert.equal((await invoke(claimReminderAlerts, f.request())).data.length, 0);
    t.mock.timers.setTime(new Date('2026-10-28T11:00:00Z').getTime());
    assert.equal((await invoke(claimReminderAlerts, f.request())).data.length, 1);
    assert.equal((await invoke(claimReminderAlerts, f.request())).data.length, 0);
    t.mock.timers.setTime(new Date('2026-10-29T08:00:00Z').getTime());
    assert.equal((await invoke(claimReminderAlerts, f.request())).data.length, 1);
});
test('daily list filters use occurrenceAt, and protected edits preserve the existing claim state', async t => {
    const f = fixture(t); const result = await setPatientContactFollowUp(f.request({action: 'remind'}));
    const req = f.request(); req.query = {from: '2026-10-29T00:00:00Z', to: '2026-10-29T23:59:59Z'};
    const listed = await invoke(getReminders, req); assert.equal(listed.data.length, 1); assert.equal(listed.data[0].occurrenceAt, '2026-10-29T08:00:00.000Z');
    const params = {reminderId: result.reminder.id};
    t.mock.timers.setTime(new Date('2026-10-27T10:00:00Z').getTime()); await invoke(claimReminderAlerts, f.request());
    assert.equal((await invoke(updateReminder, f.request({title: 'Titolo corretto'}, params))).status, 200);
    assert.equal(f.states.length, 1); assert.equal((await invoke(claimReminderAlerts, f.request())).data.length, 0);
    assert.equal((await invoke(updateReminder, f.request({patientId: other}, params))).status, 422);
    assert.equal((await invoke(completeReminder, f.request({}, params))).status, 200);
    assert.equal((await invoke(getReminderById, f.request({}, params))).data.status, 'DONE');
});
test('a stale editor cannot reopen a source reminder completed while its save was starting', async t => {
    const f = fixture(t); const result = await setPatientContactFollowUp(f.request({action: 'remind'}));
    const transaction = sequelize.transaction;
    t.mock.method(sequelize, 'transaction', (async (work: any) => {
        f.reminders[0].status = 'DONE'; f.reminders[0].completedAt = new Date();
        return (transaction as any)(work);
    }) as any);
    const response = await invoke(updateReminder, f.request({title: 'Bozza precedente', status: 'OPEN'}, {reminderId: result.reminder.id}));
    assert.equal(response.status, 409); assert.equal(f.reminders[0].status, 'DONE');
    assert.equal(f.reminders[0].title, 'Aggiungere recapiti per Mario Rossi');
});

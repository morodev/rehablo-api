import assert from 'node:assert/strict';
import {it, TestContext} from 'node:test';
import {Op} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import AgendaEvent from '../models/agendaEvent.model.js';
import AgendaEventException from '../models/agendaEventException.model.js';
import AppointmentReminderDelivery from '../models/appointmentReminderDelivery.model.js';
import Patient from '../../patients/models/patient.model.js';
import Structure from '../../auth/models/structure.model.js';
import {appointmentReminderSummaries, appointmentReminderTransport, sendAppointmentReminderEmail,
    prepareAppointmentReminderWhatsApp, markAppointmentReminderWhatsAppOpened} from './appointmentReminder.service.js';
import {reminderOccurrence, REMINDER_PENDING_TTL_MS} from './appointmentReminder.policy.js';

const id = (value: number) => 'bbbbbbbb-bbbb-4bbb-8bbb-' + String(value).padStart(12, '0');
function row(values: Record<string, any>): any {return {...values,
    get(key: string | object) {if (typeof key === 'string') return this[key]; const {get, update, ...value} = this; return value;},
    async update(value: any) {Object.assign(this, value); return this;}};}
function matches(value: Record<string, any>, where: any): boolean {
    return Reflect.ownKeys(where).every(key => {
        if (key === Op.and) return where[key].every((part: any) => matches(value, part));
        const expected = where[key];
        if (expected && typeof expected === 'object' && Op.in in expected) return expected[Op.in].includes(value[key as string]);
        return value[key as string] === expected;
    });
}
function fixture(t: TestContext) {
    const event = row({id: id(1), patientId: id(2), structureId: id(3), calendarId: id(4),
        status: 'CONFIRMED', start: new Date(Date.now() + 86_400_000).toISOString(), recurrence: null});
    const patient = row({id: id(2), archivedAt: null, name: 'Mario',
        emails: [{email: 'mario@example.test'}], phoneNumbers: [{phoneNumber: '3331234567', country: 'it'}]});
    const deliveries: any[] = [], sent: any[] = [], queries: any[] = [];
    const req: any = {tenantSchema: 'rehablo_test', params: {agendaEventId: id(1)}, body: {},
        user: {sub: id(4), tid: id(5), sid: id(3)}, access: {scope: 'own', userId: id(4), structureId: id(3)},
        header: () => 'reminder-request-one'};
    t.mock.method(sequelize, 'transaction', (async (work: any) => work({LOCK: {UPDATE: 'UPDATE'}})) as any);
    t.mock.method(AgendaEvent, 'schema', (() => ({
        findOne: async (options: any) => {queries.push(options); return matches(event, options.where) ? event : null;},
        findAll: async (options: any) => {queries.push(options); return matches(event, options.where) ? [event] : [];}
    })) as any);
    t.mock.method(Patient, 'schema', (() => ({findOne: async () => patient, findAll: async () => [patient]})) as any);
    t.mock.method(AgendaEventException, 'schema', (() => ({findAll: async () => []})) as any);
    t.mock.method(Structure, 'findOne', (async () => row({id: id(3), name: 'Studio Centro'})) as any);
    t.mock.method(AppointmentReminderDelivery, 'schema', (() => ({
        findOne: async ({where}: any) => deliveries.find(value => matches(value, where)) ?? null,
        findAll: async ({where}: any) => deliveries.filter(value => matches(value, where)),
        create: async (values: any) => {const value = row({id: id(100 + deliveries.length), sequence: deliveries.length + 1,
            createdAt: new Date(), ...values}); deliveries.push(value); return value;}
    })) as any);
    t.mock.method(appointmentReminderTransport, 'send', (async (input: any) => {sent.push(input);}) as any);
    return {req, event, patient, deliveries, sent, queries};
}

it('SMTP success is persisted and idempotent replay never sends again; explicit resend uses a new key', async t => {
    const f = fixture(t);
    const first = await sendAppointmentReminderEmail(f.req);
    assert.ok(first.summary.email.lastSentAt);
    assert.equal(f.sent.length, 1);
    await sendAppointmentReminderEmail(f.req);
    assert.equal(f.sent.length, 1);
    f.req.header = () => 'reminder-request-two';
    await sendAppointmentReminderEmail(f.req);
    assert.equal(f.sent.length, 2);
    assert.equal(f.deliveries.length, 2);
    assert.match(f.sent[0].message, /Studio Centro/);
    assert.doesNotMatch(f.sent[0].message, /CONFIRMED|bbbb/);
});

it('a known SMTP failure retains an older successful timestamp and allows explicit retry', async t => {
    const f = fixture(t);
    const original = await sendAppointmentReminderEmail(f.req);
    f.req.header = () => 'reminder-request-two';
    t.mock.method(appointmentReminderTransport, 'send', (async () => {throw Object.assign(new Error('invalid envelope'), {code: 'EENVELOPE'});}) as any);
    const result = await sendAppointmentReminderEmail(f.req);
    assert.equal(result.summary.email.lastSentAt, original.summary.email.lastSentAt);
    assert.match(result.summary.email.error!, /non inviata/);
    assert.equal(f.deliveries[1].status, 'FAILED');
});

it('uncertain SMTP outcome is persisted and a replay cannot automatically duplicate it', async t => {
    const f = fixture(t);
    let attempts = 0;
    t.mock.method(appointmentReminderTransport, 'send', (async () => {attempts++; throw Object.assign(new Error('lost SMTP reply'), {code: 'ETIMEDOUT', command: 'DATA'});}) as any);
    assert.match((await sendAppointmentReminderEmail(f.req)).summary.email.error!, /non verificabile/);
    await sendAppointmentReminderEmail(f.req);
    assert.equal(attempts, 1);
    assert.equal(f.deliveries[0].status, 'UNKNOWN');
});

it('parallel pending delivery blocks another key while stale pending can be recovered explicitly', async t => {
    const f = fixture(t);
    const occurrence = reminderOccurrence(f.event, null);
    const pending = row({id: id(100), agendaEventId: f.event.id, occurrenceKey: occurrence.occurrenceKey,
        snapshotHash: occurrence.snapshotHash, channel: 'email', status: 'PENDING', idempotencyKey: 'previous-request', createdAt: new Date()});
    f.deliveries.push(pending);
    await assert.rejects(sendAppointmentReminderEmail(f.req), /già in corso/);
    assert.equal(f.sent.length, 0);
    pending.createdAt = new Date(Date.now() - REMINDER_PENDING_TTL_MS - 1);
    await sendAppointmentReminderEmail(f.req);
    assert.equal(pending.status, 'UNKNOWN');
    assert.equal(f.sent.length, 1);
});

it('channel refusals and scoped appointment queries prevent delivery from stale contacts or another premise', async t => {
    const f = fixture(t);
    f.patient.emailNotificationsConsent = false;
    await assert.rejects(sendAppointmentReminderEmail(f.req), /disabilitate/);
    assert.equal(f.sent.length, 0);
    f.patient.emailNotificationsConsent = null;
    f.req.user.sid = id(99);
    await assert.rejects(sendAppointmentReminderEmail(f.req), /non trovato/);
    f.req.user.sid = id(3);
    f.event.calendarId = id(99);
    await assert.rejects(sendAppointmentReminderEmail(f.req), /non trovato/);
    assert.equal(f.sent.length, 0);
});

it('WhatsApp preparation does not claim an opening and repeated opening acknowledgement keeps one timestamp', async t => {
    const f = fixture(t);
    const prepared = await prepareAppointmentReminderWhatsApp(f.req);
    assert.match(prepared.url, /^https:\/\/wa.me\/393331234567\?text=/);
    assert.equal(f.deliveries[0].openedAt, undefined);
    f.req.params.deliveryId = prepared.deliveryId;
    const opened = await markAppointmentReminderWhatsAppOpened(f.req);
    assert.ok(opened.summary.whatsapp.lastOpenedAt);
    assert.equal(opened.summary.email.lastSentAt, null);
    const replay = await markAppointmentReminderWhatsAppOpened(f.req);
    assert.equal(replay.summary.whatsapp.lastOpenedAt, opened.summary.whatsapp.lastOpenedAt);
    f.req.params.agendaEventId = id(80);
    await assert.rejects(markAppointmentReminderWhatsAppOpened(f.req), /non trovato/);
});

it('batch summaries are scoped and re-read current patient consents', async t => {
    const f = fixture(t);
    f.req.body.appointments = [{eventId: f.event.id}, {eventId: id(90)}];
    f.patient.whatsappNotificationsConsent = false;
    const result = await appointmentReminderSummaries(f.req);
    assert.equal(result.length, 2);
    assert.equal(result[0].whatsapp.available, false);
    assert.equal(result[0].email.available, true);
    assert.equal(result[1].email.available, false);
    assert.equal(result[1].whatsapp.available, false);
    assert.equal(result[1].email.lastSentAt, null);
    assert.match(result[1].email.unavailableReason!, /non disponibile/);
});

it('recurring deliveries remain attached to their concrete occurrence', async t => {
    const f = fixture(t);
    f.event.start = '2030-07-01T08:00:00.000Z';
    f.event.end = '2030-07-10T20:00:00.000Z';
    f.event.duration = 45;
    f.event.recurrence = 'FREQ=DAILY';
    f.req.body.occurrenceStart = '2030-07-02T08:00:00.000Z';
    await sendAppointmentReminderEmail(f.req);
    f.req.body.appointments = [{eventId: f.event.id, occurrenceStart: '2030-07-02T08:00:00.000Z'},
        {eventId: f.event.id, occurrenceStart: '2030-07-03T08:00:00.000Z'}];
    const result = await appointmentReminderSummaries(f.req);
    assert.ok(result[0].email.lastSentAt);
    assert.equal(result[1].email.lastSentAt, null);
    assert.notEqual(result[0].occurrenceStart, result[1].occurrenceStart);
});

it('WhatsApp acknowledgements cannot attach another operator delivery or an old patient snapshot', async t => {
    const f = fixture(t);
    const prepared = await prepareAppointmentReminderWhatsApp(f.req);
    f.req.params.deliveryId = prepared.deliveryId;
    f.deliveries[0].requestedBy = id(90);
    await assert.rejects(markAppointmentReminderWhatsAppOpened(f.req), /non trovata/);
    f.deliveries[0].requestedBy = f.req.user.sub;
    f.event.patientId = id(91);
    await assert.rejects(markAppointmentReminderWhatsAppOpened(f.req), /non trovata/);
    assert.equal(f.deliveries[0].openedAt, undefined);
});

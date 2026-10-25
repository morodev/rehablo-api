import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ActivitySchedule} from '../activities.types.js';
import {ActivityError} from './activityErrors.js';
import {
    activityLocalDate, effectiveDueAt, isActivityOverdue, parseActivityCivilDate, parseActivityDue,
    parseActivityAlert, parseActivityQuery, parseActivityUtcInstant, parseCreateActivityInput, parseMoveActivityInput,
    parsePatchActivityInput, validateActivitySchedule
} from './activityValidation.js';

const operationId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
const now = new Date('2026-03-28T12:00:00.000Z');
const schedule = (fields: Partial<ActivitySchedule> = {}): ActivitySchedule => ({
    due: {kind: 'timed', at: '2026-03-28T12:02:00.000Z'},
    alert: null, assigneeIds: [userId], status: 'TODO', ...fields
});
function invalid(action: () => unknown, field?: string, code = 'ACTIVITY_VALIDATION_FAILED') {
    assert.throws(action, error => error instanceof ActivityError && error.statusCode === 422 && error.code === code
        && (!field || !!error.fields?.[field]));
}

test('UTC and civil parsing reject rollovers, local/offset timestamps and malformed dates', () => {
    for (const instant of ['2026-02-30T10:00:00Z', '2026-01-01T24:00:00Z', '2026-13-01T10:00:00Z',
        '2026-03-29T02:30:00', '2026-10-25T02:30:00', '2026-03-28T13:00:00+01:00', '0000-01-01T00:00:00Z']) {
        invalid(() => parseActivityUtcInstant(instant), 'due.at');
    }
    for (const date of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-00-01', '0000-01-01', '28/03/2026']) {
        invalid(() => parseActivityCivilDate(date), 'due.date');
    }
    assert.equal(parseActivityCivilDate('2000-02-29'), '2000-02-29');
    assert.equal(parseActivityUtcInstant('2026-03-28T12:00:00.1Z'), '2026-03-28T12:00:00.100Z');
});

test('due variants cannot contain both time and civil-date fields or override the board timezone', () => {
    invalid(() => parseActivityDue({kind: 'allDay', date: '2026-03-28', timezone: 'America/New_York'}), 'due.timezone');
    invalid(() => parseActivityDue({kind: 'allDay', date: '2026-03-28', timezone: 'Europe/Rome', at: '2026-03-28T12:00:00Z'}), 'due.at');
    invalid(() => parseActivityDue({kind: 'timed', at: '2026-03-28T12:00:00Z', date: '2026-03-28'}), 'due.date');
});

test('all-day end uses Rome midnight across the 23-hour and 25-hour DST dates', () => {
    const end = (date: string) => effectiveDueAt({kind: 'allDay', date, timezone: 'Europe/Rome'})!;
    assert.equal(end('2026-03-29').toISOString(), '2026-03-29T21:59:59.999Z');
    assert.equal(end('2026-03-29').getTime() - end('2026-03-28').getTime(), 23 * 3_600_000);
    assert.equal(end('2026-10-25').toISOString(), '2026-10-25T22:59:59.999Z');
    assert.equal(end('2026-10-25').getTime() - end('2026-10-24').getTime(), 25 * 3_600_000);
    assert.equal(activityLocalDate(new Date('2026-03-28T23:30:00Z')), '2026-03-29');
});

test('fresh submission time rejects a schedule that expired after the editor opened', () => {
    validateActivitySchedule(schedule(), null, now);
    invalid(() => validateActivitySchedule(schedule(), null, new Date('2026-03-28T12:02:00.000Z')), 'due.at');
    invalid(() => validateActivitySchedule(schedule({due: {kind: 'timed', at: now.toISOString()}}), null, now), 'due.at');
});

test('all-day today is valid through its final millisecond and becomes overdue on the next civil day', () => {
    const due = {kind: 'allDay', date: '2026-03-28', timezone: 'Europe/Rome'} as const;
    validateActivitySchedule(schedule({due}), null, new Date('2026-03-28T22:59:59.998Z'));
    validateActivitySchedule(schedule({due}), null, new Date('2026-03-28T22:59:59.999Z'));
    assert.equal(isActivityOverdue(due, 'TODO', null, new Date('2026-03-28T22:59:59.999Z')), false);
    assert.equal(isActivityOverdue(due, 'TODO', null, new Date('2026-03-28T23:00:00.000Z')), true);
    invalid(() => validateActivitySchedule(schedule({due}), null, new Date('2026-03-28T23:00:00.000Z')), 'due.date');
    assert.equal(isActivityOverdue(due, 'COMPLETED', null, new Date('2026-03-29T12:00:00Z')), false);
    assert.equal(isActivityOverdue(due, 'TODO', '2026-03-29T00:00:00Z', new Date('2026-03-29T12:00:00Z')), false);
});

test('unchanged historical due and alert permit unrelated edits, while rescheduling rechecks current time', () => {
    const original = schedule({due: {kind: 'timed', at: '2020-02-03T08:09:10.123Z'},
        alert: {scheduledAt: '2020-02-03T07:09:10.123Z', channels: ['inApp']}});
    validateActivitySchedule(original, original, now);
    invalid(() => validateActivitySchedule({...original, due: {kind: 'timed', at: '2020-02-03T08:10:00.000Z'}}, original, now), 'due.at');
    invalid(() => validateActivitySchedule({...original, alert: {scheduledAt: '2020-02-03T07:10:00.000Z', channels: ['inApp']}}, original, now),
        'alert.scheduledAt', 'INVALID_ALERT');
    validateActivitySchedule({...original, alert: null, assigneeIds: []}, original, now);
});

test('alerts need a future instant, recipients and an open lifecycle; a deadline is optional and bounds alerts when present', () => {
    validateActivitySchedule(schedule({alert: {scheduledAt: '2026-03-28T12:02:00.000Z', channels: ['inApp']}}), null, now);
    for (const candidate of [
        schedule({alert: {scheduledAt: now.toISOString(), channels: ['inApp']}}),
        schedule({alert: {scheduledAt: '2026-03-28T12:03:00.000Z', channels: ['inApp']}}),
        schedule({assigneeIds: [], alert: {scheduledAt: '2026-03-28T12:01:00.000Z', channels: ['inApp']}}),
        schedule({status: 'COMPLETED', alert: {scheduledAt: '2026-03-28T12:01:00.000Z', channels: ['inApp']}}),
        schedule({archivedAt: now, alert: {scheduledAt: '2026-03-28T12:01:00.000Z', channels: ['inApp']}})
    ]) invalid(() => validateActivitySchedule(candidate, null, now), undefined, 'INVALID_ALERT');
});

test('create normalizes text and defaults without accepting arbitrary persisted fields or child state', () => {
    const parsed = parseCreateActivityInput({operationId, title: '  New activity  ', description: '   ',
        assigneeIds: [userId, userId], checklist: [{text: '  Step  '}],
        alert: {scheduledAt: '2026-03-28T12:01:00Z', channels: ['email', 'email']}});
    assert.equal(parsed.title, 'New activity');
    assert.equal(parsed.description, null);
    assert.equal(parsed.status, 'TODO');
    assert.equal(parsed.priority, 'NORMAL');
    assert.deepEqual(parsed.assigneeIds, [userId]);
    assert.deepEqual(parsed.checklist, [{text: 'Step'}]);
    assert.deepEqual(parsed.alert?.channels, ['inApp', 'email']);
    for (const request of [
        {operationId, title: '   '}, {operationId, title: 'x'.repeat(201)},
        {operationId, title: 'Valid', description: 'x'.repeat(5001)},
        {operationId, title: 'Valid', boardId: operationId},
        {operationId, title: 'Valid', checklist: [{text: 'Step', checked: true}]},
        {operationId, title: 'Valid', checklist: [{text: 'x'.repeat(301)}]}
    ]) invalid(() => parseCreateActivityInput(request));
});

test('PATCH preserves omitted fields, distinguishes null and rejects state or children changes', () => {
    const parsed = parsePatchActivityInput({operationId, expectedVersion: 1, changes: {description: null, due: null, alert: null}});
    assert.deepEqual(parsed.changes, {description: null, due: null, alert: null});
    assert.ok(!Object.hasOwn(parsed.changes, 'title'));
    for (const changes of [{}, {status: 'COMPLETED'}, {checklist: []}, {version: 9}, {assigneeIds: [42]}]) {
        invalid(() => parsePatchActivityInput({operationId, expectedVersion: 1, changes}));
    }
    invalid(() => parsePatchActivityInput({operationId, expectedVersion: 0, changes: {title: 'Valid'}}), 'expectedVersion');
});

test('moves require canonical anchors and actual numeric revisions instead of indexes or coercion', () => {
    const base = {operationId, expectedVersion: 1, expectedOrderRevision: 0, targetStatus: 'IN_PROGRESS'};
    assert.deepEqual(parseMoveActivityInput({...base, placement: {kind: 'before', activityId: userId}}).placement,
        {kind: 'before', activityId: userId});
    for (const command of [
        {...base, placement: {kind: 'before'}}, {...base, placement: {kind: 'end', currentIndex: 2}},
        {...base, placement: {kind: 'start'}, expectedVersion: '1'},
        {...base, placement: {kind: 'start'}, expectedOrderRevision: -1},
        {...base, placement: {kind: 'start'}, targetStatus: 'in_progress'},
        {...base, placement: {kind: 'start'}, allowIncompleteChecklist: 'true'}
    ]) invalid(() => parseMoveActivityInput(command));
});

test('query normalization deduplicates status order and bounds independent column windows', () => {
    const parsed = parseActivityQuery({statuses: 'WAITING,TODO,WAITING', mine: 'false', limit: '30',
        limits: '{"TODO":25,"COMPLETED":40}', cursors: '{"TODO":"opaque-cursor"}'});
    assert.deepEqual(parsed.statuses, ['TODO', 'WAITING']);
    assert.equal(parsed.mine, false);
    assert.equal(parsed.limit, 30);
    assert.deepEqual(parsed.limits, {TODO: 25, COMPLETED: 40});
    assert.deepEqual(parsed.cursors, {TODO: 'opaque-cursor'});
    for (const query of [{mine: '1'}, {mine: ['true', 'false']}, {limit: '0'}, {limit: '201'},
        {limits: '{"TODO":201}'}, {limits: '{"UNKNOWN":20}'}, {cursors: '{"TODO":42}'},
        {structureId: userId}, {statuses: 'TODO,unknown'}]) invalid(() => parseActivityQuery(query));
});

test('UTC disambiguates both occurrences of the repeated Rome hour without a local-time guess', () => {
    const first = parseActivityUtcInstant('2026-10-25T00:30:00Z');
    const second = parseActivityUtcInstant('2026-10-25T01:30:00Z');
    const format = new Intl.DateTimeFormat('it-IT', {timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
    assert.equal(format.format(new Date(first)), '02:30');
    assert.equal(format.format(new Date(second)), '02:30');
    assert.notEqual(first, second);
    const between = new Date('2026-10-25T01:00:00Z');
    invalid(() => validateActivitySchedule(schedule({due: {kind: 'timed', at: first}}), null, between), 'due.at');
    validateActivitySchedule(schedule({due: {kind: 'timed', at: second}}), null, between);
});

test('an all-day alert may reach its actual DST day end, but cannot cross into the next civil day', () => {
    const due = {kind: 'allDay', date: '2026-03-29', timezone: 'Europe/Rome'} as const;
    const end = effectiveDueAt(due)!;
    validateActivitySchedule(schedule({due, alert: {scheduledAt: end.toISOString(), channels: ['inApp']}}), null, now);
    invalid(() => validateActivitySchedule(schedule({due, alert: {
        scheduledAt: new Date(end.getTime() + 1).toISOString(), channels: ['inApp']
    }}), null, now), 'alert.scheduledAt', 'INVALID_ALERT');
});

test('an unchanged past civil day survives edits while switching it to an elapsed timed due is rescheduling', () => {
    const original = schedule({due: {kind: 'allDay', date: '2026-03-27', timezone: 'Europe/Rome'}});
    validateActivitySchedule({...original, assigneeIds: []}, original, now);
    invalid(() => validateActivitySchedule({...original, due: {
        kind: 'allDay', date: '2026-03-26', timezone: 'Europe/Rome'
    }}, original, now), 'due.date');
    invalid(() => validateActivitySchedule({...original, due: {
        kind: 'timed', at: '2026-03-27T22:59:59.999Z'
    }}, original, now), 'due.at');
});

test('equivalent UTC representations preserve historical milliseconds instead of creating a false reschedule', () => {
    const original = schedule({due: {kind: 'timed', at: '2020-02-03T08:09:10Z'},
        alert: {scheduledAt: '2020-02-03T07:09:10Z', channels: ['inApp', 'email']}});
    validateActivitySchedule({...original,
        due: {kind: 'timed', at: '2020-02-03T08:09:10.000Z'},
        alert: {scheduledAt: '2020-02-03T07:09:10.000Z', channels: ['email', 'inApp']}
    }, original, now);
    invalid(() => validateActivitySchedule({...original, due: {
        kind: 'timed', at: '2020-02-03T08:09:10.001Z'
    }}, original, now), 'due.at');
});

test('removing the last recipient requires cancelling the active alert while a deadline can be removed independently', () => {
    const original = schedule({alert: {scheduledAt: '2026-03-28T12:01:00.000Z', channels: ['inApp']}});
    invalid(() => validateActivitySchedule({...original, assigneeIds: []}, original, now), 'assigneeIds', 'INVALID_ALERT');
    validateActivitySchedule({...original, due: null}, original, now);
    validateActivitySchedule({...original, assigneeIds: [], due: null, alert: null}, original, now);
});

test('a channel change cannot reactivate a historical alert without a new future instant', () => {
    const original = schedule({due: {kind: 'timed', at: '2020-02-03T08:09:10.123Z'},
        alert: {scheduledAt: '2020-02-03T07:09:10.123Z', channels: ['inApp']}});
    invalid(() => validateActivitySchedule({...original, alert: {
        scheduledAt: original.alert!.scheduledAt, channels: ['inApp', 'push']
    }}, original, now), 'alert.scheduledAt', 'INVALID_ALERT');
});

test('an optional schedule stays empty, whereas malformed alert input is never silently disabled', () => {
    validateActivitySchedule(schedule({due: null, alert: null, assigneeIds: []}), null, now);
    assert.equal(effectiveDueAt(null), null);
    assert.equal(parseActivityAlert(null), null);
    for (const scheduledAt of ['', '2026-02-30T12:00:00Z', '2026-03-28T13:00:00+01:00']) {
        invalid(() => parseActivityAlert({scheduledAt}), 'alert.scheduledAt');
    }
    const pastOriginal = schedule({due: {kind: 'timed', at: '2020-02-03T08:00:00Z'}});
    validateActivitySchedule({...pastOriginal, status: 'COMPLETED'}, pastOriginal, now);
});

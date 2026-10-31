import assert from 'node:assert/strict';
import {test} from 'node:test';
import {activityExecutionDeadline, addRecurrenceDays, nextRecurrenceDate, parseActivityRecurrenceRule,
    recurrenceDateOnOrAfter, recurrenceLocalDate, recurrenceOutcome} from './activityRecurrence.policy.js';

test('daily recurrence keeps a fixed civil-date anchor and inclusive end', () => {
    const rule = parseActivityRecurrenceRule({frequency: 'daily', interval: 2, startsOn: '2026-11-02', endsOn: '2026-11-06'});
    assert.equal(nextRecurrenceDate(rule, '2026-11-02'), '2026-11-04');
    assert.equal(nextRecurrenceDate(rule, '2026-11-04'), '2026-11-06');
    assert.equal(nextRecurrenceDate(rule, '2026-11-06'), null);
    assert.equal(recurrenceDateOnOrAfter(rule, '2026-11-03'), '2026-11-04');
    assert.equal(recurrenceDateOnOrAfter(rule, '2026-11-07'), null);
});

test('weekly intervals retain the weekday even when processing resumes late', () => {
    const rule = parseActivityRecurrenceRule({frequency: 'weekly', interval: 2, startsOn: '2026-11-02', endsOn: null});
    assert.equal(recurrenceDateOnOrAfter(rule, '2026-11-09'), '2026-11-16');
    assert.equal(nextRecurrenceDate(rule, '2026-11-16'), '2026-11-30');
});

test('a series can consist of one day and indefinite recurrences do not invent a termination', () => {
    const single = parseActivityRecurrenceRule({frequency: 'daily', interval: 1, startsOn: '2026-11-02', endsOn: '2026-11-02'});
    assert.equal(nextRecurrenceDate(single, single.startsOn), null);
    const endless = {...single, endsOn: null};
    let date = endless.startsOn;
    for (let count = 0; count < 1000; count++) date = nextRecurrenceDate(endless, date)!;
    assert.equal(date, addRecurrenceDays(endless.startsOn, 1000));
});

test('daylight saving and winter time close the execution at local midnight', () => {
    assert.equal(activityExecutionDeadline('2026-03-28').toISOString(), '2026-03-28T23:00:00.000Z');
    assert.equal(activityExecutionDeadline('2026-03-29').toISOString(), '2026-03-29T22:00:00.000Z');
    assert.equal(activityExecutionDeadline('2026-10-24').toISOString(), '2026-10-24T22:00:00.000Z');
    assert.equal(activityExecutionDeadline('2026-10-25').toISOString(), '2026-10-25T23:00:00.000Z');
    assert.equal(recurrenceLocalDate(new Date('2026-11-01T23:01:00Z')), '2026-11-02');
});

test('date arithmetic handles month/year/leap boundaries without accepting normalized invalid dates', () => {
    assert.equal(addRecurrenceDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addRecurrenceDays('2026-12-31', 1), '2027-01-01');
    for (const startsOn of ['2026-02-29', '2026-13-01', '2026-04-31', '02/11/2026']) {
        assert.throws(() => parseActivityRecurrenceRule({frequency: 'daily', interval: 1, startsOn, endsOn: null}));
    }
});

test('rule validation rejects unsupported values and an end before the first day', () => {
    const valid = {frequency: 'daily', interval: 1, startsOn: '2026-11-02', endsOn: null};
    for (const changes of [{frequency: 'monthly'}, {interval: 0}, {interval: 1.5}, {interval: Infinity},
        {interval: '2'}, {endsOn: '2026-11-01'}, {unexpected: true}]) {
        assert.throws(() => parseActivityRecurrenceRule({...valid, ...changes}));
    }
});

test('deadline outcomes distinguish approval pending, partial work and missing recordings', () => {
    assert.equal(recurrenceOutcome('COMPLETED', 'approved', 2, 2), 'completed');
    assert.equal(recurrenceOutcome('WAITING', 'pending', 2, 2), 'pending_review');
    assert.equal(recurrenceOutcome('IN_PROGRESS', 'not_requested', 1, 2), 'partial');
    assert.equal(recurrenceOutcome('TODO', 'not_requested', 0, 2), 'not_recorded');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    AvailabilityValidationError,
    emptyAvailabilitySchedule,
    normalizeAvailabilitySchedule
} from './userAvailabilityPolicy.service.js';

function schedule() {
    return Array.from({length: 7}, (_, day) => ({
        day,
        enabled: day === 0,
        rangeOneStart: day === 0 ? '09:00' : null,
        rangeOneFinish: day === 0 ? '12:00' : null
    }));
}

test('normalizza sette giorni e gli orari PostgreSQL', () => {
    const result = normalizeAvailabilitySchedule(
        schedule(),
        'CUSTOM',
        [{day: 0, enabled: true, open: '08:00:00', close: '18:00:00'}]
    );
    assert.equal(result.length, 7);
    assert.equal(result[0].rangeOneStart, '09:00:00');
    assert.equal(result[0].rangeOneFinish, '12:00:00');
});

test('rifiuta fasce fuori dall apertura della sede', () => {
    assert.throws(
        () => normalizeAvailabilitySchedule(
            schedule(),
            'CUSTOM',
            [{day: 0, enabled: true, open: '10:00:00', close: '18:00:00'}]
        ),
        AvailabilityValidationError
    );
});

test('rifiuta fasce sovrapposte', () => {
    const value = schedule();
    Object.assign(value[0], {
        rangeTwoStart: '11:00',
        rangeTwoFinish: '13:00'
    });
    assert.throws(
        () => normalizeAvailabilitySchedule(
            value,
            'CUSTOM',
            [{day: 0, enabled: true, open: '08:00', close: '18:00'}]
        ),
        AvailabilityValidationError
    );
});

test('rifiuta giorni duplicati in modalita personalizzata', () => {
    const value = schedule();
    value[6].day = 0;
    assert.throws(
        () => normalizeAvailabilitySchedule(
            value,
            'CUSTOM',
            [{day: 0, enabled: true, open: '08:00', close: '18:00'}]
        ),
        AvailabilityValidationError
    );
});

test('ignora fasce obsolete o incomplete quando segue la sede', () => {
    const result = normalizeAvailabilitySchedule([
        {day: 0, enabled: true, rangeOneStart: null, rangeOneFinish: null}
    ], 'INHERIT_STRUCTURE');

    assert.deepEqual(result, emptyAvailabilitySchedule());
});

test('accetta un orario personalizzato senza giorni attivi', () => {
    const result = normalizeAvailabilitySchedule(
        emptyAvailabilitySchedule(),
        'CUSTOM',
        []
    );
    assert.ok(result.every((day) => !day.enabled));
});

test('ordina e compatta le fasce personalizzate', () => {
    const value = schedule();
    Object.assign(value[0], {
        rangeOneStart: '14:00',
        rangeOneFinish: '18:00',
        rangeTwoStart: '09:00',
        rangeTwoFinish: '12:00'
    });
    const result = normalizeAvailabilitySchedule(
        value,
        'CUSTOM',
        [{day: 0, enabled: true, open: '08:00', close: '20:00'}]
    );

    assert.equal(result[0].rangeOneStart, '09:00:00');
    assert.equal(result[0].rangeOneFinish, '12:00:00');
    assert.equal(result[0].rangeTwoStart, '14:00:00');
    assert.equal(result[0].rangeTwoFinish, '18:00:00');
});

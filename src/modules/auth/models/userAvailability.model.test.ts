import assert from 'node:assert/strict';
import test from 'node:test';
import UserAvailability, {
    missingUserAvailabilityTimeColumns,
    USER_AVAILABILITY_TIME_COLUMNS
} from './userAvailability.model.js';

test('ogni fascia oraria usa una colonna Sequelize distinta', () => {
    const mappedFields = USER_AVAILABILITY_TIME_COLUMNS.map((column) => {
        const attribute = UserAvailability.rawAttributes[column];
        assert.ok(attribute, `Attributo ${column} mancante`);
        assert.equal(attribute.field, column);
        assert.equal((attribute as any).fieldName, column);
        return attribute.field;
    });

    assert.equal(new Set(mappedFields).size, USER_AVAILABILITY_TIME_COLUMNS.length);
});

test('riconosce tutte le colonne mancanti dello schema legacy', () => {
    const legacyColumns = {
        id: {},
        day: {},
        enabled: {},
        rangeOneStart: {},
        userId: {},
        createdAt: {},
        updatedAt: {}
    };

    assert.deepEqual(missingUserAvailabilityTimeColumns(legacyColumns), [
        'rangeOneFinish',
        'rangeTwoStart',
        'rangeTwoFinish',
        'rangeThreeStart',
        'rangeThreeFinish',
        'rangeFourStart',
        'rangeFourFinish'
    ]);
});

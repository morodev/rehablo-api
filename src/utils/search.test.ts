import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    boundedInteger,
    escapeLikePattern,
    normalizeSearchQuery,
    searchTokens,
    textSearchWhere
} from './search.js';

describe('search helpers', () => {
    test('normalizes case and repeated whitespace', () => {
        assert.equal(normalizeSearchQuery('  Mario   DE\tRossi  '), 'mario de rossi');
        assert.deepEqual(searchTokens('  Mario   DE\tRossi  '), ['mario', 'de', 'rossi']);
    });

    test('escapes LIKE metacharacters so they remain literal', () => {
        assert.equal(escapeLikePattern('50%_test\\value'), '50\\%\\_test\\\\value');
        assert.deepEqual(searchTokens('50% _test'), ['50\\%', '\\_test']);
    });

    test('bounds paging and autocomplete values', () => {
        assert.equal(boundedInteger('25', 20, 1, 50), 25);
        assert.equal(boundedInteger('200', 20, 1, 50), 50);
        assert.equal(boundedInteger('-4', 20, 1, 50), 1);
        assert.equal(boundedInteger('invalid', 20, 1, 50), 20);
    });

    test('does not add a database condition for an empty query', () => {
        assert.equal(textSearchWhere(['name'], '   '), null);
        assert.ok(textSearchWhere(['name', 'surname'], 'mario rossi'));
    });
});

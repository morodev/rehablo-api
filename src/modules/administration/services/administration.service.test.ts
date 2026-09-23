import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MockFiscalGateway } from './fiscalGateway.service.js';
import {
    resolveAdministrationDateRange, resolveAdministrationStructure, romeDateBoundary
} from './administrationQuery.service.js';
import { choosePriceList, PriceResolutionCandidate } from './pricing.service.js';
import { normalizeQuoteLines } from '../controllers/administration.controller.js';

const candidates: PriceResolutionCandidate[] = [
    { priceListId: 'standard', priceListName: 'Standard', priority: 0, source: 'DEFAULT' },
    { priceListId: 'insurance', priceListName: 'Assicurazione', priority: 20, source: 'DEFAULT' },
    { priceListId: 'corporate', priceListName: 'Azienda', priority: 10, source: 'DEFAULT' }
];

describe('administration pricing', () => {
    it('uses explicit, patient, structure and tenant preferences in that order', () => {
        assert.equal(choosePriceList(candidates, [
            { id: 'standard', source: 'EXPLICIT' },
            { id: 'insurance', source: 'PATIENT' }
        ])?.priceListId, 'standard');
        assert.equal(choosePriceList(candidates, [
            { id: null, source: 'EXPLICIT' },
            { id: 'insurance', source: 'PATIENT' },
            { id: 'corporate', source: 'STRUCTURE' }
        ])?.source, 'PATIENT');
    });

    it('falls back to the active list with the highest priority', () => {
        assert.equal(choosePriceList(candidates, [])?.priceListId, 'insurance');
        assert.equal(choosePriceList([], []), null);
    });
});

describe('mock fiscal gateway', () => {
    it('returns a deterministic sandbox protocol without performing a real transmission', async () => {
        const gateway = new MockFiscalGateway();
        const request = { channel: 'STS' as const, documentId: 'doc-1', payload: { amount: 100 } };
        const first = await gateway.submit(request);
        const second = await gateway.submit(request);
        assert.equal(gateway.sandbox, true);
        assert.equal(first.status, 'ACCEPTED');
        assert.equal(first.externalId, second.externalId);
        assert.match(first.protocolNumber ?? '', /^SANDBOX-STS-/);
    });

    it('supports a controlled rejection for UI and retry tests', async () => {
        const result = await new MockFiscalGateway().submit({
            channel: 'SDI', documentId: 'doc-2', payload: { forceReject: true }
        });
        assert.equal(result.status, 'REJECTED');
        assert.match(result.error ?? '', /simulato/);
    });
});

describe('administration query scope', () => {
    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';

    it('returns no rows instead of using a non-UUID sentinel when a structure is missing', () => {
        assert.deepEqual(resolveAdministrationStructure({ scope: 'structure', structureId: null }, null), { kind: 'none' });
    });

    it('enforces the token structure and ignores a different requested structure', () => {
        assert.deepEqual(
            resolveAdministrationStructure({ scope: 'structure', structureId: first }, second),
            { kind: 'structure', structureId: first }
        );
    });

    it('allows tenant scope to select all or one valid structure', () => {
        assert.deepEqual(resolveAdministrationStructure({ scope: 'tenant' }, null), { kind: 'all' });
        assert.deepEqual(resolveAdministrationStructure({ scope: 'tenant' }, second), { kind: 'structure', structureId: second });
        assert.throws(() => resolveAdministrationStructure({ scope: 'tenant' }, '__none__'), /structureId non valido/);
    });
});

describe('administration date range', () => {
    it('keeps the complete selected calendar month', () => {
        const period = resolveAdministrationDateRange('2026-09-01', '2026-09-30');
        assert.equal(period.from, '2026-09-01');
        assert.equal(period.to, '2026-09-30');
        assert.equal(period.fromInstant?.toISOString(), '2026-08-31T22:00:00.000Z');
        assert.equal(period.toInstant?.toISOString(), '2026-09-30T21:59:59.999Z');
    });

    it('uses Europe/Rome boundaries across daylight-saving changes', () => {
        assert.equal(romeDateBoundary('2026-03-29', false).toISOString(), '2026-03-28T23:00:00.000Z');
        assert.equal(romeDateBoundary('2026-03-29', true).toISOString(), '2026-03-29T21:59:59.999Z');
    });

    it('rejects malformed or reversed periods', () => {
        assert.throws(() => resolveAdministrationDateRange('2026-09-31', '2026-10-01'), /from non valida/);
        assert.throws(() => resolveAdministrationDateRange('2026-10-01', '2026-09-30'), /periodo selezionato/);
    });
});

describe('quote line totals', () => {
    it('rounds each custom line before summing the subtotal, matching the final total', () => {
        const payload: Record<string, unknown> = {
            lines: [
                { itemType: 'CUSTOM', description: 'Prestazione a tempo', quantity: 1.5, unitPrice: 10.33, baseUnitPrice: 10.33 },
                { itemType: 'CUSTOM', description: 'Prodotto a misura', quantity: 1.5, unitPrice: 10.33, baseUnitPrice: 10.33 }
            ]
        };

        assert.equal(normalizeQuoteLines(payload, true), null);
        assert.equal(payload['subtotal'], 31);
        assert.equal(payload['total'], 31);
        assert.deepEqual((payload['lines'] as Array<Record<string, unknown>>).map(line => line['total']), [15.5, 15.5]);
    });

    it('preserves the rounded base amount when a price-list discount applies', () => {
        const payload: Record<string, unknown> = {
            lines: [
                { itemType: 'SERVICE', itemId: 'service-1', description: 'Trattamento', quantity: 1.5, unitPrice: 8.33, baseUnitPrice: 10.33 },
                { itemType: 'CUSTOM', description: 'Materiale', quantity: 1.5, unitPrice: 10.33, baseUnitPrice: 10.33 }
            ]
        };

        assert.equal(normalizeQuoteLines(payload, true), null);
        assert.equal(payload['subtotal'], 31);
        assert.equal(payload['total'], 28);
        assert.equal(Number(payload['subtotal']) - Number(payload['total']), 3);
        const lines = payload['lines'] as Array<Record<string, unknown>>;
        assert.equal(lines[0]['baseUnitPrice'], 10.33);
        assert.equal(lines[0]['unitPrice'], 8.33);
        assert.equal(lines[0]['total'], 12.5);
    });
});

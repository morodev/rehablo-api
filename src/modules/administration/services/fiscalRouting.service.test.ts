import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    FISCAL_ROUTING_RULE_VERSION,
    FiscalRoutingInput,
    resolveFiscalRouting,
} from './fiscalRouting.service.js';

const person = (over: Partial<FiscalRoutingInput['recipient']> = {}): FiscalRoutingInput['recipient'] => ({
    kind: 'PERSON', hasVatNumber: false, taxCode: 'RSSMRA80A01H501U', sdiCode: null, pec: null, ...over,
});
const business = (over: Partial<FiscalRoutingInput['recipient']> = {}): FiscalRoutingInput['recipient'] => ({
    kind: 'BUSINESS', hasVatNumber: true, taxCode: '12345678901', sdiCode: 'ABCDEF1', pec: null, ...over,
});
const service = { kind: 'SERVICE' as const, isHealthcare: true };
const product = { kind: 'PRODUCT' as const, isHealthcare: false };

const input = (over: Partial<FiscalRoutingInput> = {}): FiscalRoutingInput => ({
    documentType: 'fattura',
    recipient: person(),
    lines: [service],
    patientOpposesTs: false,
    stsIssuerConfigured: true,
    stsExpenseTypeResolved: true,
    ...over,
});

describe('resolveFiscalRouting', () => {
    it('carries the versioned rule set on every decision', () => {
        assert.equal(resolveFiscalRouting(input()).ruleVersion, FISCAL_ROUTING_RULE_VERSION);
    });

    it('sanitario B2C senza opposizione: fuori SDI, candidato TS', () => {
        const d = resolveFiscalRouting(input());
        assert.equal(d.sdi.required, false);
        assert.equal(d.sts.eligible, true);
        assert.deepEqual(d.channels, ['STS']);
        assert.equal(d.blocks.length, 0);
        assert.equal(d.sts.healthcareLineCount, 1);
    });

    it('sanitario B2C con opposizione: fuori SDI ed escluso dal TS', () => {
        const d = resolveFiscalRouting(input({ patientOpposesTs: true }));
        assert.equal(d.sdi.required, false);
        assert.equal(d.sts.eligible, false);
        assert.deepEqual(d.channels, []);
        assert.match(d.warnings.join(' '), /Opposizione TS/);
    });

    it('documento misto B2C: fuori SDI e solo righe sanitarie al TS', () => {
        const d = resolveFiscalRouting(input({ lines: [service, product] }));
        assert.equal(d.sdi.required, false);
        assert.equal(d.sts.eligible, true);
        assert.equal(d.sts.healthcareLineCount, 1);
        assert.deepEqual(d.channels, ['STS']);
        assert.match(d.warnings.join(' '), /misto/i);
    });

    it('B2C con sole voci non sanitarie: percorso SDI ordinario, niente TS', () => {
        const d = resolveFiscalRouting(input({ lines: [product] }));
        assert.equal(d.sdi.required, true);
        assert.equal(d.sts.eligible, false);
        assert.deepEqual(d.channels, ['SDI']);
    });

    it('B2C non sanitario senza codice fiscale: SDI bloccato per dato mancante', () => {
        const d = resolveFiscalRouting(input({ lines: [product], recipient: person({ taxCode: null }) }));
        assert.equal(d.sdi.required, true);
        assert.deepEqual(d.channels, []);
        assert.match(d.blocks.join(' '), /codice fiscale/);
    });

    it('B2B: percorso SDI, mai TS, anche con righe sanitarie', () => {
        const d = resolveFiscalRouting(input({ recipient: business(), lines: [service] }));
        assert.equal(d.sdi.required, true);
        assert.equal(d.sts.eligible, false);
        assert.deepEqual(d.channels, ['SDI']);
    });

    it('B2B senza codice destinatario né PEC: SDI bloccato', () => {
        const d = resolveFiscalRouting(input({ recipient: business({ sdiCode: null, pec: null }) }));
        assert.equal(d.sdi.required, true);
        assert.deepEqual(d.channels, []);
        assert.match(d.blocks.join(' '), /codice destinatario SDI o la PEC/);
    });

    it('B2B con PEC ma senza codice destinatario è ammesso', () => {
        const d = resolveFiscalRouting(input({ recipient: business({ sdiCode: null, pec: 'ditta@pec.it' }) }));
        assert.deepEqual(d.channels, ['SDI']);
        assert.equal(d.blocks.length, 0);
    });

    it('profilo TS non configurato: sanitario fuori SDI ma TS bloccato', () => {
        const d = resolveFiscalRouting(input({ stsIssuerConfigured: false }));
        assert.equal(d.sdi.required, false);
        assert.equal(d.sts.eligible, false);
        assert.deepEqual(d.channels, []);
        assert.match(d.blocks.join(' '), /Collegamenti fiscali/);
    });

    it('tipo di spesa non risolto: TS bloccato con indicazione', () => {
        const d = resolveFiscalRouting(input({ stsExpenseTypeResolved: false }));
        assert.equal(d.sts.eligible, false);
        assert.match(d.blocks.join(' '), /tipo di spesa/i);
    });

    it('righe non classificate: segnala la necessità di classificazione', () => {
        const d = resolveFiscalRouting(input({ lines: [{ kind: 'PRODUCT', isHealthcare: null }] }));
        assert.equal(d.needsHealthcareClassification, true);
        assert.match(d.warnings.join(' '), /classificazione sanitaria/);
    });

    it('documento senza righe: bloccato', () => {
        const d = resolveFiscalRouting(input({ lines: [] }));
        assert.deepEqual(d.channels, []);
        assert.match(d.blocks.join(' '), /non contiene righe/);
    });

    it('committente PERSON ma con partita IVA è trattato come B2B', () => {
        const d = resolveFiscalRouting(input({ recipient: person({ hasVatNumber: true, sdiCode: 'ABCDEF1' }), lines: [service] }));
        assert.equal(d.sdi.required, true);
        assert.equal(d.sts.eligible, false);
    });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSdiPayload, buildStsPayload } from './fiscalPayload.js';
import { InvoiceIssuerSnapshot, InvoiceRecipientSnapshot } from '../../invoice/models/invoice.model.js';

const issuer: InvoiceIssuerSnapshot = {
    stsIssuerType: 'PHYSIOTHERAPIST', businessName: 'Studio Rossi', vatNumber: '01234567890', taxCode: null,
    address: 'Via Roma 1', city: 'Perugia', province: 'PG', zipCode: '06100', pec: null, email: null, phone: null,
    taxRegime: 'RF01',
};
const businessRecipient: InvoiceRecipientSnapshot = {
    kind: 'BUSINESS', businessName: 'Palestra Alfa Srl', firstName: null, lastName: null, taxCode: null,
    vatNumber: '99999999999', address: 'Via Verdi 3', city: 'Roma', province: 'RM', zipCode: '00100',
    country: 'IT', sdiCode: 'ABCDEF1', pec: null, email: null,
};

describe('buildSdiPayload', () => {
    it('genera l’XML FatturaPA per un input valido', () => {
        const result = buildSdiPayload({
            issuer, recipient: businessRecipient, progressivo: '2026000012',
            lines: [{ kind: 'PRODUCT', name: 'Tutore', vat: '22', quantity: 1, unitPrice: 100 }],
            document: { documentType: 'fattura', documentNumber: 12, documentYear: 2026, emissionDate: '2026-03-15' },
        });
        assert.equal(result.channel, 'SDI');
        assert.deepEqual(result.errors, []);
        assert.match(result.xml ?? '', /FatturaElettronica/);
    });

    it('segnala gli errori strutturali senza produrre XML', () => {
        const incomplete = { ...businessRecipient, zip: null, zipCode: null, city: null };
        const result = buildSdiPayload({
            issuer, recipient: incomplete as any, progressivo: '2026000013',
            lines: [{ kind: 'PRODUCT', name: 'Tutore', vat: '22', quantity: 1, unitPrice: 100 }],
            document: { documentType: 'fattura', documentNumber: 13, documentYear: 2026, emissionDate: '2026-03-15' },
        });
        assert.equal(result.xml, null);
        assert.ok(result.errors.length > 0);
    });
});

describe('buildStsPayload', () => {
    const base = {
        proprietario: { cfProprietario: '01234567890' },
        invoice: { documentNumber: 5, documentYear: 2026, emissionDate: '2026-03-15' },
        fiscalCode: 'BNCMRA80A01H501U',
        opposizione: false,
        tipoSpesa: 'SP',
        annoFiscale: 2026,
    };

    it('genera il tracciato TS quando c’è un importo pagato', () => {
        const result = buildStsPayload({ ...base, payment: { paidAmount: 80, paidAt: '2026-04-01', traceable: true } });
        assert.equal(result.channel, 'STS');
        assert.deepEqual(result.errors, []);
        assert.match(result.xml ?? '', /invioTelematico/);
        assert.match(result.xml ?? '', /<importo>80\.00<\/importo>/);
    });

    it('non trasmette senza importo pagato', () => {
        const result = buildStsPayload({ ...base, payment: { paidAmount: 0, paidAt: null, traceable: false } });
        assert.equal(result.xml, null);
        assert.match(result.errors.join(' '), /Nessun importo pagato/);
    });

    it('non trasmette in caso di opposizione', () => {
        const result = buildStsPayload({ ...base, opposizione: true, payment: { paidAmount: 80, paidAt: '2026-04-01', traceable: true } });
        assert.equal(result.xml, null);
        assert.match(result.errors.join(' '), /opposto/);
    });
});

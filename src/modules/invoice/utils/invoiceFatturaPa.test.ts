import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateFatturaPaInput } from './fatturaPa.js';
import {
    InvoiceLineLike,
    invoiceRoutingLines,
    mapInvoiceToFatturaPa,
    parseLineVat,
} from './invoiceFatturaPa.js';
import { InvoiceIssuerSnapshot, InvoiceRecipientSnapshot } from '../models/invoice.model.js';

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

describe('parseLineVat', () => {
    it('interpreta aliquote e nature', () => {
        assert.deepEqual(parseLineVat('22'), { vatRate: 22, natura: null });
        assert.deepEqual(parseLineVat('N4'), { vatRate: 0, natura: 'N4' });
        assert.deepEqual(parseLineVat('n2.2'), { vatRate: 0, natura: 'N2.2' });
        assert.deepEqual(parseLineVat(''), { vatRate: 0, natura: null });
        assert.deepEqual(parseLineVat(null), { vatRate: 0, natura: null });
    });
});

describe('invoiceRoutingLines', () => {
    it('classifica i servizi come sanitari e i prodotti come non sanitari', () => {
        const lines: InvoiceLineLike[] = [
            { kind: 'SERVICE', name: 'Seduta', vat: 'N4', quantity: 1, unitPrice: 50 },
            { kind: 'PRODUCT', name: 'Tutore', vat: '22', quantity: 1, unitPrice: 30 },
        ];
        assert.deepEqual(invoiceRoutingLines(lines), [
            { kind: 'SERVICE', isHealthcare: true },
            { kind: 'PRODUCT', isHealthcare: false },
        ]);
    });
});

describe('mapInvoiceToFatturaPa', () => {
    const products: InvoiceLineLike[] = [{ kind: 'PRODUCT', name: 'Tutore', vat: '22', quantity: 2, unitPrice: 30 }];
    const totals = { discSellingPrice: 60, invoiceVAT: 13.2, invoiceTotal: 73.2, invoiceNet: 73.2 };

    it('produce un input B2B valido dallo snapshot', () => {
        const input = mapInvoiceToFatturaPa({
            issuer, recipient: businessRecipient, lines: products, progressivo: '2026000012',
            document: { ...totals, documentType: 'fattura', documentNumber: 12, documentYear: 2026, emissionDate: '2026-03-15' },
        });
        assert.deepEqual(validateFatturaPaInput(input), []);
        assert.equal(input.transmission.senderCode, '01234567890');
        assert.equal(input.transmission.codiceDestinatario, 'ABCDEF1');
        assert.equal(input.cedente.regimeFiscale, 'RF01');
        assert.equal(input.cessionario.denominazione, 'Palestra Alfa Srl');
        assert.equal(input.cessionario.vatNumber, '99999999999');
        assert.equal(input.document.tipoDocumento, 'TD01');
        assert.equal(input.lines[0].vatRate, 22);
    });

    it('usa 0000000 come codice destinatario senza codice SDI', () => {
        const recipient: InvoiceRecipientSnapshot = {
            kind: 'PERSON', businessName: null, firstName: 'Mario', lastName: 'Bianchi', taxCode: 'BNCMRA80A01H501U',
            vatNumber: null, address: 'Via Milano 2', city: 'Milano', province: 'MI', zipCode: '20100',
            country: 'IT', sdiCode: null, pec: null, email: null,
        };
        const input = mapInvoiceToFatturaPa({
            issuer, recipient, lines: products, progressivo: '2026000013',
            document: { ...totals, documentType: 'fattura', documentNumber: 13, documentYear: 2026, emissionDate: '2026-03-16' },
        });
        assert.equal(input.transmission.codiceDestinatario, '0000000');
        assert.equal(input.cessionario.nome, 'Mario');
        assert.equal(input.cessionario.cognome, 'Bianchi');
        assert.deepEqual(validateFatturaPaInput(input), []);
    });

    it('mappa la nota di credito su TD04', () => {
        const input = mapInvoiceToFatturaPa({
            issuer, recipient: businessRecipient, lines: products, progressivo: '2026000014',
            document: { ...totals, documentType: 'nota_di_credito', documentNumber: 14, documentYear: 2026, emissionDate: '2026-03-17' },
        });
        assert.equal(input.document.tipoDocumento, 'TD04');
    });

    it('dichiara il bollo anche se non riaddebitato, distinguendolo dal totale a pagare', () => {
        const withStamp = mapInvoiceToFatturaPa({
            issuer, recipient: businessRecipient, lines: products, progressivo: '2026000015',
            document: {
                ...totals, invoiceTotal: 75.2, invoiceNet: 75.2,
                documentType: 'fattura', documentNumber: 15, documentYear: 2026, emissionDate: '2026-03-18',
                isStamp: true, stampAmount: 2, stampChargedToPatient: true,
            },
        });
        assert.deepEqual(withStamp.document.bollo, { virtuale: true, importo: 2, chargedToCustomer: true });

        const notCharged = mapInvoiceToFatturaPa({
            issuer, recipient: businessRecipient, lines: products, progressivo: '2026000016',
            document: {
                ...totals,
                documentType: 'fattura', documentNumber: 16, documentYear: 2026, emissionDate: '2026-03-18',
                isStamp: true, stampAmount: 2, stampChargedToPatient: false,
            },
        });
        assert.deepEqual(notCharged.document.bollo, { virtuale: true, importo: 2, chargedToCustomer: false });
    });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildPublicInvoicePayload,
    isPlausibleEmail,
    primaryPatientEmail,
    withPatientEmail
} from './invoiceShare.js';

const internalInvoice = {
    id: 'inv-1',
    documentType: 'fattura',
    documentNumber: 12,
    documentYear: 2026,
    emissionDate: '2026-09-14',
    invoiceTotal: 100,
    paymentStatus: 'partial',
    fiscalNotes: ['Operazione esente IVA art. 10 n. 18'],
    issuer: { businessName: 'Studio Rossi', vatNumber: '01234567890' },
    services: [{
        serviceName: 'Seduta',
        quantity: 2,
        servicePrice: 50,
        totalPrice: 100,
        serviceVat: 'N4'
    }],
    products: [],
    // Campi gestionali che NON devono raggiungere il paziente.
    payments: [{ id: 'pay-1', amount: 40, method: 'contanti' }],
    paidAmount: 40,
    balance: 60,
    stsSent: true,
    stsExcluded: false,
    appointmentLinks: [{ id: 'link-1', agendaEventId: 'evt-1' }],
    internalNotes: 'paziente moroso'
};

test('il payload pubblico espone i dati del documento', () => {
    const payload = buildPublicInvoicePayload(internalInvoice, {
        name: 'Mario',
        surname: 'Bianchi',
        fiscalCode: 'BNCMRA80A01H501U',
        address: 'Via Verdi 2'
    });

    assert.equal(payload.documentNumber, 12);
    assert.equal(payload.invoiceTotal, 100);
    assert.equal(payload.issuer?.businessName, 'Studio Rossi');
    assert.deepEqual(payload.fiscalNotes, ['Operazione esente IVA art. 10 n. 18']);
    assert.equal(payload.recipient?.name, 'Mario Bianchi');
    assert.equal((payload.services[0] as Record<string, unknown>).serviceName, 'Seduta');
});

test('il payload pubblico non trasporta i dati gestionali', () => {
    const payload = buildPublicInvoicePayload(internalInvoice, null) as unknown as Record<string, unknown>;

    for (const leaked of ['payments', 'paidAmount', 'balance', 'stsSent', 'stsExcluded', 'appointmentLinks', 'internalNotes']) {
        assert.equal(leaked in payload, false, `il campo "${leaked}" non deve uscire dal gestionale`);
    }
});

test('le righe espongono solo le colonne del documento', () => {
    const payload = buildPublicInvoicePayload(internalInvoice, null);
    const line = payload.services[0] as Record<string, unknown>;

    assert.deepEqual(
        Object.keys(line).sort(),
        ['originalServicePrice', 'quantity', 'serviceName', 'servicePrice', 'serviceVat', 'totalPrice']
    );
});

test('lo stato di storno resta visibile perché invalida il documento', () => {
    const payload = buildPublicInvoicePayload({ ...internalInvoice, paymentStatus: 'void' }, null);
    assert.equal(payload.paymentStatus, 'void');
});

test('riconosce gli indirizzi email plausibili', () => {
    assert.equal(isPlausibleEmail('mario.bianchi@example.it'), true);
    assert.equal(isPlausibleEmail('  MARIO@EXAMPLE.IT '), true);
    assert.equal(isPlausibleEmail('mario@example'), false);
    assert.equal(isPlausibleEmail('mario bianchi@example.it'), false);
    assert.equal(isPlausibleEmail(''), false);
    assert.equal(isPlausibleEmail(null), false);
});

test('prende il primo indirizzo utilizzabile dell anagrafica', () => {
    assert.equal(primaryPatientEmail([{ email: 'non valido' }, { email: 'ok@example.it' }]), 'ok@example.it');
    assert.equal(primaryPatientEmail([]), null);
    assert.equal(primaryPatientEmail(null), null);
});

test('aggiunge l indirizzo senza perdere quelli esistenti', () => {
    const result = withPatientEmail([{ email: 'vecchia@example.it', label: 'Casa' }], 'nuova@example.it');
    assert.deepEqual(result, [
        { email: 'vecchia@example.it', label: 'Casa' },
        { email: 'nuova@example.it', label: 'Fatturazione' }
    ]);
});

test('non riscrive l anagrafica se l indirizzo c e gia', () => {
    assert.equal(withPatientEmail([{ email: 'Mario@Example.IT' }], 'mario@example.it'), null);
});

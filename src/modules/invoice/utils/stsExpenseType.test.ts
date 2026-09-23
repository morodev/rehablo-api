import assert from 'node:assert/strict';
import { it } from 'node:test';
import { buildIssuerSnapshot } from './issuer.js';
import { buildSistemaTSRecord } from './sistemaTS.js';
import { getStsFiscalSettings, invoiceStsCodeForSave, resolveStsExpenseType, validateStsFiscalSettings } from './stsExpenseType.js';

const physio = { stsIssuerType: 'PHYSIOTHERAPIST' as const, stsDefaultExpenseTypeCode: 'SP' };
const structure = { stsIssuerType: 'AUTHORIZED_STRUCTURE' as const, stsDefaultExpenseTypeCode: 'SR' };
const none = { stsIssuerType: null, stsDefaultExpenseTypeCode: null };
const serviceOnly = { products: [], services: [{ serviceName: 'Trattamento' }] };

it('does not infer a TS issuer from tax regime, business name or license', () => {
    assert.deepEqual(getStsFiscalSettings({ taxRegime: 'RF01', businessName: 'Fisioterapista', subscription: 'PRO' }), none);
    assert.equal(buildIssuerSnapshot({ taxRegime: 'RF01' }).stsIssuerType, null);
});
it('physiotherapist settings normalize SP, while each structure needs an explicit default', () => {
    assert.deepEqual(validateStsFiscalSettings({ stsIssuerType: 'PHYSIOTHERAPIST' }, none), physio);
    assert.deepEqual(validateStsFiscalSettings({ stsIssuerType: 'AUTHORIZED_STRUCTURE' }, physio), { ...structure, stsDefaultExpenseTypeCode: null });
    assert.throws(() => validateStsFiscalSettings({ ...structure, stsDefaultExpenseTypeCode: 'SP' }, none), /non è previsto/);
    assert.throws(() => validateStsFiscalSettings({ ...structure, stsDefaultExpenseTypeCode: 'TK' }, none), /non è previsto/);
    assert.equal(validateStsFiscalSettings({ stsIssuerType: 'ACCREDITED_STRUCTURE', stsDefaultExpenseTypeCode: 'TK' }, none).stsDefaultExpenseTypeCode, 'TK');
});
it('rejects unknown profiles and non-string expense codes', () => {
    assert.throws(() => validateStsFiscalSettings({ stsIssuerType: 'CLINIC' }, none), /profilo valido/);
    assert.throws(() => validateStsFiscalSettings({ stsDefaultExpenseTypeCode: 123 }, physio), /tipo di spesa/);
});
it('resolves SP only for a declared physiotherapist with services and no products', () => {
    assert.deepEqual(resolveStsExpenseType(serviceOnly, physio), { stsIssuerType: 'PHYSIOTHERAPIST', stsExpenseTypeCode: 'SP', stsExpenseTypeSource: 'PROFILE', issue: null });
    for (const lines of [{ products: [{}], services: [{}] }, { products: [{}], services: [] }, { products: [], services: [] }, { services: [{}] }]) {
        assert.equal(resolveStsExpenseType(lines, physio).stsExpenseTypeCode, null);
        assert.equal(resolveStsExpenseType(lines, physio).issue?.field, 'stsExpenseTypeCode');
    }
});
it('ordinary invoice emission stays possible before TS configuration; explicit invalid codes do not', () => {
    assert.equal(invoiceStsCodeForSave(serviceOnly, none, undefined), null);
    assert.throws(() => invoiceStsCodeForSave({ ...serviceOnly, stsExpenseTypeCode: 'SP' }, none, 'SP'), /Configura il profilo/);
    assert.throws(() => invoiceStsCodeForSave({ ...serviceOnly, stsExpenseTypeCode: 'SR' }, physio, 'SR'), /non è previsto/);
    assert.throws(() => invoiceStsCodeForSave(serviceOnly, physio, {}), /tipo di spesa/);
});
it('persists an explicit blank choice and infers a default only when the input is omitted', () => {
    for (const explicitValue of [null, '', '   ']) {
        assert.equal(invoiceStsCodeForSave({ ...serviceOnly, stsExpenseTypeCode: explicitValue }, physio, explicitValue), null);
        assert.equal(invoiceStsCodeForSave({ ...serviceOnly, stsExpenseTypeCode: explicitValue }, structure, explicitValue), null);
    }
    assert.equal(invoiceStsCodeForSave(serviceOnly, physio, undefined), 'SP');
    assert.equal(invoiceStsCodeForSave(serviceOnly, structure, undefined), 'SR');
});
it('a saved code takes precedence and an invalid old placeholder must be corrected explicitly', () => {
    assert.equal(resolveStsExpenseType({ ...serviceOnly, stsExpenseTypeCode: 'AA' }, structure).stsExpenseTypeSource, 'SAVED');
    const invalid = resolveStsExpenseType({ ...serviceOnly, stsExpenseTypeCode: 'PRESTAZIONE_SANITARIA_FISIOTERAPICA' }, physio);
    assert.equal(invalid.stsExpenseTypeCode, null);
    assert.equal(invalid.issue?.field, 'stsExpenseTypeCode');
});
it('preserves the historical issuer profile after a tenant profile change', () => {
    const invoice = { ...serviceOnly, issuer: { stsIssuerType: 'PHYSIOTHERAPIST' } };
    assert.equal(resolveStsExpenseType(invoice, structure).stsExpenseTypeCode, 'SP');
    const previousStructure = { ...serviceOnly, issuer: { stsIssuerType: 'ACCREDITED_STRUCTURE' } };
    assert.equal(resolveStsExpenseType(previousStructure, structure).stsExpenseTypeCode, null);
    assert.equal(resolveStsExpenseType({ ...previousStructure, stsExpenseTypeCode: 'TK' }, structure).stsExpenseTypeCode, 'TK');
});
it('legacy invoices use the declared current profile without mutating their saved fields', () => {
    const invoice = { ...serviceOnly, issuer: { businessName: 'Studio storico' }, stsExpenseTypeCode: null };
    const before = structuredClone(invoice);
    assert.equal(resolveStsExpenseType(invoice, physio).stsExpenseTypeCode, 'SP');
    assert.deepEqual(invoice, before);
});
it('draft exports use the same resolver and keep historical issuer fiscal identity', () => {
    const input: any = { invoice: { ...serviceOnly, id: 'invoice', documentNumber: 9, documentYear: 2026,
        emissionDate: '2026-09-01', invoiceTotal: 100, issuer: { vatNumber: 'OLD', stsIssuerType: 'PHYSIOTHERAPIST' } },
        patient: { fiscalCode: 'RSSMRA80A01H501U' }, tenant: { VATNumber: 'NEW', administrationSettings: { fiscal: structure } } };
    const value = buildSistemaTSRecord(input);
    assert.equal(value.tipoSpesa, 'SP');
    assert.equal(value.partitaIvaErogatore, 'OLD');
    input.invoice.products = [{}];
    assert.throws(() => buildSistemaTSRecord(input), /Seleziona il tipo di spesa/);
    input.invoice.stsExpenseTypeCode = 'PRESTAZIONE_SANITARIA_FISIOTERAPICA';
    assert.throws(() => buildSistemaTSRecord(input), /non è previsto/);
});

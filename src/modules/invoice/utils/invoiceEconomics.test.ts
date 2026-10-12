import assert from 'node:assert/strict';
import { it } from 'node:test';
import { evalTotals, evalTotalsDetailed, toPersistedTotals } from './evalTotals.js';
import { getTaxRegime } from './fiscalRegime.js';
import { buildSdiPayloadFromInvoice } from '../../administration/services/fiscalPayload.js';
import { runTransmission } from '../../administration/services/fiscalTransmission.service.js';

const issuer = { businessName: 'Studio sintetico', vatNumber: '01234567890', taxCode: null,
    address: 'Via Roma 1', city: 'Roma', province: 'RM', zipCode: '00100', taxRegime: 'RF01' };
const recipient = { kind: 'BUSINESS', businessName: 'Cliente sintetico', firstName: null, lastName: null,
    vatNumber: '99999999999', taxCode: null, address: 'Via Roma 2', city: 'Roma', province: 'RM',
    zipCode: '00100', country: 'IT', sdiCode: 'ABCDEF1', pec: null };
const product = (price = 100, vat = '22', quantity = 1, id = 'line-1') => ({
    id, productName: 'Prodotto sintetico', productPrice: price, productVat: vat, quantity, totalPrice: price * quantity
});

function invoice(overrides: Record<string, any> = {}) {
    const data: Record<string, any> = { id: 'invoice', documentType: 'fattura', documentNumber: 12, documentYear: 2026,
        emissionDate: '2026-10-12', issuer, recipient, products: [product()], services: [],
        discountType: 'percentage', discountAmount: 0, isRivals: false, isCashPro: false, isTaxWithholding: false,
        isStamp: false, stampChargedToPatient: false, vatNature: 'N4', ...overrides };
    const totals = evalTotals({ ...data,
        products: data.products.map((line: any) => ({ sellingPrice: Number(line.productPrice), quantity: Number(line.quantity), productVat: line.productVat })),
        services: data.services.map((line: any) => ({ sellingPrice: Number(line.servicePrice), quantity: Number(line.quantity), productVat: line.serviceVat })),
        appliesVat: getTaxRegime(data.issuer?.taxRegime).appliesVat });
    return { ...data, ...toPersistedTotals(totals) } as Record<string, any>;
}
function xmlOf(data: Record<string, any>) {
    const before = structuredClone(data);
    const result = buildSdiPayloadFromInvoice(data);
    assert.deepEqual(data, before, 'export must not mutate historical data');
    assert.deepEqual(result.errors, []);
    assert.ok(result.xml);
    return result.xml!;
}
function total(xml: string) { return Number(xml.match(/<ImportoTotaleDocumento>([^<]+)</)?.[1]); }

it('preserves the existing total result while exposing exact proportional bases and per-line VAT', () => {
    const input = { products: [{ sellingPrice: 100, quantity: 1, productVat: '22' }], discountType: 'percentage' as const, discountAmount: 10 };
    const detail = evalTotalsDetailed(input);
    assert.deepEqual(detail.totals, evalTotals(input));
    assert.deepEqual(detail.lines, [{ totalLinePrice: 100, discountedPrice: 90, vatRate: 22, vatAmount: 19.8, rivalsAmount: 0 }]);
});
it('exports an undiscounted control invoice at122', () => assert.equal(total(xmlOf(invoice())), 122));
for (const [price, vat, expectedVat, expectedTotal] of [
    [5.75, '22', 1.27, 7.02], [0.35, '10', 0.04, 0.39],
    [1.45, '10', 0.15, 1.60], [20.70, '5', 1.04, 21.74]
] as const) {
    it(`uses canonical cent rounding for ${price} at VAT ${vat}%`, () => {
        const data = invoice({ products: [product(price, vat)] });
        assert.equal(data.invoiceVAT, expectedVat);
        assert.equal(data.invoiceTotal, expectedTotal);
        const xml = xmlOf(data);
        assert.equal(total(xml), expectedTotal);
        assert.ok(xml.includes(`<Imposta>${expectedVat.toFixed(2)}</Imposta>`));
    });
}
it('ignores disabled contribution and withholding rates without inventing extra XML components', () => {
    const xml = xmlOf(invoice({ isRivals: false, rivals: 4, isTaxWithholding: false, taxWithholding: 20 }));
    assert.equal(total(xml), 122);
    assert.doesNotMatch(xml, /DatiRitenuta|DatiCassaPrevidenziale/);
});
for (const discountType of ['percentage', 'value']) {
    it(`reconciles ${discountType} discount10: persisted109.80 and XML109.80`, () => {
        const data = invoice({ discountType, discountAmount: 10 });
        assert.equal(data.invoiceTotal, 109.8);
        const xml = xmlOf(data);
        assert.equal(total(xml), 109.8);
        assert.match(xml, /<ScontoMaggiorazione><Tipo>SC<\/Tipo><Importo>10\.00<\/Importo>/);
        assert.match(xml, /<PrezzoTotale>90\.00<\/PrezzoTotale>/);
        assert.match(xml, /<ImponibileImporto>90\.00<\/ImponibileImporto><Imposta>19\.80<\/Imposta>/);
    });
}
it('allocates discounts across mixed VAT and exempt groups', () => {
    const data = invoice({ products: [product(100, '22'), product(100, '10', 1, 'line-2'), product(100, 'N4', 1, 'line-3')], discountAmount: 10 });
    assert.equal(data.invoiceTotal, 298.8);
    const xml = xmlOf(data);
    assert.equal(total(xml), 298.8);
    assert.match(xml, /<Natura>N4<\/Natura><ImponibileImporto>90\.00/);
    const fixed = invoice({ products: data.products, discountType: 'value', discountAmount: 30 });
    assert.equal(total(xmlOf(fixed)), 298.8);
});
it('keeps a one-euro discount exact across three lines, including DECIMAL strings', () => {
    const data = invoice({ products: [product(100, 'N4', 1, 'b'), product(100, 'N4', 1, 'a'), product(100, 'N4', 1, 'c')], discountType: 'value', discountAmount: '1.00' });
    for (const key of ['discSellingPrice', 'invoiceVAT', 'invoiceTotal', 'invoiceNet']) data[key] = data[key].toFixed(2);
    data.products.forEach((line: any) => { line.productPrice = String(line.productPrice); line.quantity = String(line.quantity); });
    const xml = xmlOf(data);
    assert.equal(total(xml), 299);
    assert.match(xml, /<ImponibileImporto>299\.00/);
    assert.equal(xml, xmlOf({ ...data, products: [...data.products].reverse() }), 'row load order must not change residual allocation');
});
it('represents a document discount on a quantity greater than one without discounting twice', () => {
    const data = invoice({ products: [product(100, 'N4', 3)], discountType: 'value', discountAmount: 1 });
    const xml = xmlOf(data);
    assert.equal(total(xml), 299);
    assert.match(xml, /<Importo>0\.33333333<\/Importo>/);
    assert.match(xml, /<PrezzoTotale>299\.00<\/PrezzoTotale>/);
});
it('does not reapply appointment concessions or use original tariff to allocate document discount', () => {
    const data = invoice({ products: [], services: [
        { id: 'a', serviceName: 'Seduta', servicePrice: 50, serviceVat: 'N4', quantity: 1, totalPrice: 50 },
        { id: 'b', serviceName: 'Seduta', servicePrice: 100, serviceVat: 'N4', quantity: 1, totalPrice: 100 }
    ], discountAmount: 10 });
    data.sellingPrice = 300;
    assert.equal(data.invoiceTotal, 135);
    assert.equal(total(xmlOf(data)), 135);
});
for (const taxRegime of ['RF19', 'RF02']) {
    it(`uses frozen ${taxRegime} over catalog22, emitting N2.2 and no VAT`, () => {
        const data = invoice({ issuer: { ...issuer, taxRegime }, discountAmount: 10 });
        const xml = xmlOf(data);
        assert.equal(total(xml), 90);
        assert.match(xml, /<AliquotaIVA>0\.00<\/AliquotaIVA><Natura>N2\.2<\/Natura>/);
        assert.doesNotMatch(xml, /<AliquotaIVA>22/);
    });
}
for (const charged of [true, false]) {
    it(`declares stamp independently from recharge=${charged}`, () => {
        const data = invoice({ products: [product(100, 'N4')], isStamp: true, stampAmount: 2, stampChargedToPatient: charged });
        const xml = xmlOf(data);
        assert.match(xml, /<DatiBollo><BolloVirtuale>SI<\/BolloVirtuale><ImportoBollo>2\.00/);
        assert.equal(total(xml), charged ? 102 : 100);
    });
}
it('keeps a credit-note positive amount convention and TD04', () => {
    const xml = xmlOf(invoice({ documentType: 'nota_di_credito', discountAmount: 10 }));
    assert.equal(total(xml), 109.8);
    assert.match(xml, /<TipoDocumento>TD04<\/TipoDocumento>/);
});

const invalidCases: Array<[string, (data: Record<string, any>) => void, string]> = [
    ['missing issuer', data => { data.issuer = null; }, 'INCOMPLETE_FISCAL_SNAPSHOT'],
    ['missing recipient', data => { data.recipient = null; }, 'INCOMPLETE_FISCAL_SNAPSHOT'],
    ['missing regime', data => { data.issuer = { ...issuer, taxRegime: null }; }, 'INCOMPLETE_FISCAL_SNAPSHOT'],
    ['unknown regime', data => { data.issuer = { ...issuer, taxRegime: 'UNKNOWN' }; }, 'INCOMPLETE_FISCAL_SNAPSHOT'],
    ['invalid date', data => { data.emissionDate = '2026-02-30'; }, 'INVALID_FISCAL_SNAPSHOT'],
    ['missing document number', data => { data.documentNumber = null; }, 'INCOMPLETE_FISCAL_SNAPSHOT'],
    ['missing total', data => { delete data.invoiceTotal; }, 'INCOMPLETE_FISCAL_SNAPSHOT'],
    ['mismatching total', data => { data.invoiceTotal = 121; }, 'FISCAL_TOTAL_MISMATCH'],
    ['missing VAT nature', data => { data.products[0].productVat = null; data.vatNature = null; }, 'INCOMPLETE_FISCAL_SNAPSHOT'],
    ['unknown VAT', data => { data.products[0].productVat = 'unknown'; }, 'INCOMPLETE_FISCAL_SNAPSHOT'],
    ['line discount legacy', data => { data.products[0].percentageDiscount = 10; }, 'UNSUPPORTED_FISCAL_METADATA'],
    ['line total mismatch', data => { data.products[0].totalPrice = 99; }, 'FISCAL_TOTAL_MISMATCH'],
    ['invalid quantity', data => { data.products[0].quantity = 0; }, 'INVALID_FISCAL_SNAPSHOT'],
    ['missing stamp recharge', data => { data.isStamp = true; data.stampAmount = 2; delete data.stampChargedToPatient; }, 'INCOMPLETE_FISCAL_SNAPSHOT'],
    ['contribution metadata', data => { data.isRivals = true; data.rivals = 4; }, 'UNSUPPORTED_FISCAL_METADATA'],
    ['withholding metadata', data => { data.isTaxWithholding = true; data.taxWithholding = 20; }, 'UNSUPPORTED_FISCAL_METADATA']
];
for (const [name, change, code] of invalidCases) {
    it(`blocks ${name} without XML, provider calls or historical mutations`, async () => {
        const data = invoice(); change(data);
        const before = structuredClone(data);
        const payload = buildSdiPayloadFromInvoice(data);
        assert.equal(payload.xml, null);
        assert.match(payload.errors.join(' '), new RegExp(code));
        let calls = 0;
        const result = await runTransmission({ currentStatus: 'QUEUED', payload,
            gateway: { provider: 'TEST', channel: 'SDI', live: false, transmit: async () => { calls++; throw new Error('must not transmit'); } },
            request: { channel: 'SDI', documentId: 'invoice', format: payload.format, xml: '', idempotencyKey: 'test' } });
        assert.equal(result.finalStatus, 'INVALID');
        assert.equal(calls, 0);
        assert.deepEqual(data, before);
    });
}
it('preserves500 from ten paid appointments and blocks unrepresentable bucket VAT instead of altering history', async () => {
    const data = invoice({ products: Array.from({ length: 10 }, (_, index) => product(40.98, '22', 1, `line-${index}`)) });
    assert.equal(data.invoiceTotal, 500);
    assert.equal(data.invoiceVAT, 90.2);
    const before = structuredClone(data);
    const payload = buildSdiPayloadFromInvoice(data);
    assert.equal(payload.xml, null);
    assert.match(payload.errors.join(' '), /UNREPRESENTABLE_FISCAL_ROUNDING/);
    let calls = 0;
    const outcome = await runTransmission({ currentStatus: 'QUEUED', payload,
        gateway: { provider: 'TEST', channel: 'SDI', live: false, transmit: async () => { calls++; throw new Error('must not transmit'); } },
        request: { channel: 'SDI', documentId: 'invoice', format: payload.format, xml: '', idempotencyKey: 'rounding' } });
    assert.equal(outcome.finalStatus, 'INVALID');
    assert.equal(calls, 0);
    assert.deepEqual(data, before);
});

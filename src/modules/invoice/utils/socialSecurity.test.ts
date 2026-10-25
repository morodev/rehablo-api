import assert from 'node:assert/strict';
import {it} from 'node:test';
import {contributionPolicy, evaluateContributionInvoice} from './socialSecurity.js';
import {evalTotals, toPersistedTotals} from './evalTotals.js';
import {buildSdiPayloadFromInvoice} from '../../administration/services/fiscalPayload.js';
import {applyAppointmentPriceSnapshot} from './appointmentInvoicePrice.js';
import {invoiceBreakdown} from './invoiceBreakdown.js';
import {isStampDutyDue, resolveFiscalProfile} from './fiscalRegime.js';
import {writeFileSync, mkdirSync} from 'node:fs';
import {resolve} from 'node:path';

const issuer = {businessName: 'Studio sintetico', vatNumber: '01234567890', taxCode: null,
    address: 'Via Roma 1', city: 'Roma', province: 'RM', zipCode: '00100', taxRegime: 'RF01'};
const recipient = {kind: 'BUSINESS', businessName: 'Cliente sintetico', firstName: null, lastName: null,
    vatNumber: '99999999999', taxCode: null, address: 'Via Roma 2', city: 'Roma', province: 'RM',
    zipCode: '00100', country: 'IT', sdiCode: 'ABCDEF1', pec: null};
const service = (price = 50, vat = 'N4', id = 'a') => ({id, serviceName: 'Seduta sintetica', servicePrice: price,
    quantity: 1, serviceVat: vat, totalPrice: price});
function invoice(mode: 'NONE' | 'EXCLUDED' | 'INCLUDED', overrides: Record<string, any> = {}) {
    const data: any = {id: 'invoice', documentType: 'fattura', documentNumber: 1, documentYear: 2026,
        emissionDate: '2026-10-23', issuer, recipient, products: [], services: [service()],
        discountType: 'percentage', discountAmount: 0, isRivals: mode !== 'NONE', rivals: 4,
        isCashPro: false, isTaxWithholding: false, isStamp: false, stampChargedToPatient: false,
        vatNature: 'N4', socialSecurityPricingMode: mode, socialSecurityFund: 'INPS_GS', ...overrides};
    const totals = evalTotals({...data, appliesVat: !['RF19', 'RF02'].includes(data.issuer.taxRegime),
        services: data.services.map((row: any) => ({sellingPrice: row.servicePrice, quantity: row.quantity, productVat: row.serviceVat, socialSecurity: row.socialSecurity})),
        products: data.products.map((row: any) => ({sellingPrice: row.productPrice, quantity: row.quantity, productVat: row.productVat}))});
    return {...data, ...toPersistedTotals(totals)};
}
function xml(data: any, fixture?: string) {
    const before = structuredClone(data);
    const result = buildSdiPayloadFromInvoice(data);
    assert.deepEqual(data, before);
    assert.deepEqual(result.errors, []);
    assert.ok(result.xml);
    for (const match of result.xml!.matchAll(/<PrezzoUnitario>(.*?)<\/PrezzoUnitario>/g)) assert.match(match[1], /^\d+\.\d{2,8}$/);
    if (fixture && process.env.SOCIAL_SECURITY_XML_FIXTURES) {
        const output = resolve(process.env.SOCIAL_SECURITY_XML_FIXTURES);
        mkdirSync(output, {recursive: true}); writeFileSync(resolve(output, fixture + '.xml'), result.xml!);
    }
    assert.match(result.xml!, new RegExp('<ImportoTotaleDocumento>' + Number(data.invoiceTotal).toFixed(2) + '</ImportoTotaleDocumento>'));
    return result.xml!;
}
it('adds 4 percent, extracts an included contribution, and keeps actual discounts separate', () => {
    assert.equal(invoice('EXCLUDED').invoiceTotal, 52);
    const included = invoice('INCLUDED');
    assert.equal(included.invoiceTotal, 50); assert.equal(included.discSellingPrice, 48.08);
    assert.equal(invoiceBreakdown(included).rivalsAmount, 1.92);
    assert.equal(invoiceBreakdown(included).discountTotal, 0);
    assert.equal(invoice('NONE').invoiceTotal, 50);
});
it('includes exempt INPS in the stamp threshold', () => {
    const result = invoice('EXCLUDED', {services: [service(75)]});
    const totals = evalTotals({...result, services: [{sellingPrice: 75, productVat: 'N4'}]});
    assert.equal(totals.vatFreeAmount, 78);
    assert.equal(isStampDutyDue(totals.vatFreeAmount, resolveFiscalProfile({taxRegime: 'RF01'})), true);
});
it('does not add INPS to products or custom compensation', () => {
    const result = evaluateContributionInvoice({policy: contributionPolicy('INPS_GS', 'EXCLUDED'), lines: [
        {type: 'SERVICE', sellingPrice: 50, productVat: 'N4'},
        {type: 'PRODUCT', sellingPrice: 100, productVat: '22'}, {type: 'CUSTOM', sellingPrice: 10, productVat: 'N4'}]});
    assert.equal(result.rivalsAmount, 2); assert.equal(result.invoiceTotal, 184);
});
for (const mode of ['NONE', 'EXCLUDED', 'INCLUDED'] as const) {
    it('exports ' + mode + ' without fictitious discounts or duplicate contribution', () => {
        const result = xml(invoice(mode), mode.toLowerCase());
        assert.equal(result.includes('<DatiCassaPrevidenziale>'), mode !== 'NONE');
        assert.ok(!result.includes('<ScontoMaggiorazione>'));
        if (mode !== 'NONE') assert.match(result, /<TipoCassa>TC22<\/TipoCassa><AlCassa>4.00<\/AlCassa>/);
    });
}
it('exports included INPS and actual document discount once', () => {
    const data = invoice('INCLUDED', {services: [service(100)], discountType: 'value', discountAmount: 10});
    assert.equal(data.invoiceTotal, 90);
    const result = xml(data, 'discount');
    assert.match(result, /<ScontoMaggiorazione>/);
});
it('exports withholding with explicit frozen type and causale and includes INPS in its base', () => {
    const data = invoice('EXCLUDED', {services: [service(100)], isTaxWithholding: true,
        taxWithholding: 20, withholdingType: 'RT01', withholdingCausale: 'A'});
    assert.equal(data.invoiceNet, 83.2);
    const result = xml(data, 'withholding');
    assert.match(result, /<ImportoRitenuta>20.80<\/ImportoRitenuta>/);
    assert.match(result, /<Ritenuta>SI<\/Ritenuta>/);
});
it('rejects missing withholding metadata instead of inferring an entity type', () => {
    const data = invoice('EXCLUDED', {isTaxWithholding: true, taxWithholding: 20});
    assert.ok(buildSdiPayloadFromInvoice(data).errors.length);
});
it('exports frozen RF19 nature without VAT even on a taxable catalogue item', () => {
    const data = invoice('EXCLUDED', {issuer: {...issuer, taxRegime: 'RF19'}, services: [service(50, '22')]});
    assert.equal(data.invoiceTotal, 52); assert.equal(data.invoiceVAT, 0);
    assert.match(xml(data, 'forfettario'), /<Natura>N2.2<\/Natura>/);
});
it('preserves a paid fifty-two-euro agreement and extracts INPS without applying it twice', () => {
    const line = applyAppointmentPriceSnapshot({source: 'SNAPSHOT', amount: 52, netAmount: 52, vatRate: 0,
        socialSecurity: contributionPolicy('INPS_GS', 'EXCLUDED')}, {unitPrice: 999, vat: 'N4'}, true);
    const data = invoice('EXCLUDED', {services: [{...service(line.unitPrice), socialSecurity: line.socialSecurity}]});
    assert.equal(data.invoiceTotal, 52); assert.equal(data.discSellingPrice, 50);
    xml(data, 'paid-session');
});
it('never adds a current contribution to a historical agreement without metadata', () => {
    const line = applyAppointmentPriceSnapshot({source: 'SNAPSHOT', amount: 50, netAmount: null, vatRate: null}, {unitPrice: 999, vat: 'N4'}, true);
    const data = invoice('EXCLUDED', {services: [{...service(line.unitPrice), socialSecurity: line.socialSecurity}]});
    assert.equal(data.invoiceTotal, 50); assert.equal(data.socialSecuritySnapshot.lines[0].contribution, 0);
});
for (const vat of ['N4', '22']) it('preserves ten separate included prices and exports reconciled totals at VAT ' + vat, () => {
    const data = invoice('INCLUDED', {services: Array.from({length: 10}, (_, index) => service(50, vat, String(index)))});
    assert.equal(data.invoiceTotal, vat === 'N4' ? 500 : 610);
    const reordered = {...data, services: [...data.services].reverse()};
    xml(reordered, vat === 'N4' ? 'cumulative-exempt' : 'cumulative-vat');
});
it('exports stamp declaration separately from customer recharge', () => {
    xml(invoice('INCLUDED', {isStamp: true, stampAmount: 2, stampChargedToPatient: true}), 'stamp-charged');
    xml(invoice('INCLUDED', {isStamp: true, stampAmount: 2, stampChargedToPatient: false}), 'stamp-studio');
});
it('rejects forged snapshots and keeps legacy contribution exports blocked', () => {
    const forged = invoice('EXCLUDED'); forged.socialSecuritySnapshot.lines[0].contribution = 999;
    assert.ok(buildSdiPayloadFromInvoice(forged).errors.length);
    const legacy = invoice('EXCLUDED'); delete legacy.socialSecuritySnapshot;
    assert.ok(buildSdiPayloadFromInvoice(legacy).errors.length);
});
it('exports credit notes using the same positive amount convention', () => {
    assert.match(xml(invoice('INCLUDED', {documentType: 'nota_di_credito'}), 'credit-note'), /<TipoDocumento>TD04<\/TipoDocumento>/);
});

it('exports an explicit frozen rounding without creating a new residual on paid VAT-inclusive sessions', () => {
    const data = invoice('INCLUDED', {services: Array.from({length: 10}, (_, index) => service(40.98, '22', String(index)))});
    assert.equal(data.invoiceTotal, 500); assert.equal(data.invoiceVAT, 90.16);
    assert.equal(data.socialSecuritySnapshot.rounding, 0.04);
    assert.match(xml(data, 'rounding'), /<Arrotondamento>0.04<\/Arrotondamento>/);
});

it('excludes products and unclassified custom lines from professional withholding', () => {
    const result = evaluateContributionInvoice({policy: contributionPolicy('INPS_GS', 'EXCLUDED'), isTaxWithholding: true, taxWithholding: 20,
        lines: [{type: 'SERVICE', sellingPrice: 100}, {type: 'PRODUCT', sellingPrice: 100}, {type: 'CUSTOM', sellingPrice: 100}]});
    assert.equal(result.taxWithholdingAmount, 20.8);
});
it('exports negative fiscal rounding on cumulative paid agreements', () => {
    const data = invoice('INCLUDED', {services: Array.from({length: 10}, (_, index) => service(41.01, '22', String(index)))});
    assert.equal(data.socialSecuritySnapshot.rounding, -0.02);
    assert.match(xml(data, 'rounding-negative'), /<Arrotondamento>-0.02<\/Arrotondamento>/);
});
it('marks only professional service lines as subject to withholding in XML', () => {
    const data = invoice('EXCLUDED', {services: [service(100)], products: [{id: 'product', productName: 'Prodotto', productPrice: 100, productVat: '22', quantity: 1, totalPrice: 100}],
        isTaxWithholding: true, taxWithholding: 20, withholdingType: 'RT01', withholdingCausale: 'A'});
    assert.equal(data.socialSecuritySnapshot.withholding.amount, 20.8);
    const details = xml(data, 'withholding-mixed').match(/<DettaglioLinee>.*?<\/DettaglioLinee>/g);
    assert.ok(details);
    assert.equal(details.length, 2);
    assert.ok(!details[0].includes('<Ritenuta>'));
    assert.ok(details[1].includes('<Ritenuta>SI</Ritenuta>'));
});

it('keeps distinct frozen contribution agreements on equal-priced lines after DB reordering', () => {
    const data = invoice('EXCLUDED', {services: [
        {...service(50, 'N4', 'z'), serviceName: 'Contributo compreso', socialSecurity: contributionPolicy('INPS_GS', 'INCLUDED')},
        {...service(50, 'N4', 'a'), serviceName: 'Contributo escluso', socialSecurity: contributionPolicy('NONE')}
    ]});
    const result = xml(data, 'mixed-agreements');
    assert.match(result, /<Descrizione>Contributo escluso<\/Descrizione>.*?<PrezzoTotale>50.00<\/PrezzoTotale>/);
    assert.match(result, /<Descrizione>Contributo compreso<\/Descrizione>.*?<PrezzoTotale>48.08<\/PrezzoTotale>/);
});

it('keeps included compensation and displayed discounts consistent across VAT groups', () => {
    const data = invoice('INCLUDED', {services: [service(50, 'N4', 'a'), service(50, '22', 'b')]});
    assert.equal(data.sellingPrice, 96.16); assert.equal(data.discSellingPrice, 96.16);
    assert.equal(invoiceBreakdown(data).discountTotal, 0);
    xml(data, 'mixed-vat');
});

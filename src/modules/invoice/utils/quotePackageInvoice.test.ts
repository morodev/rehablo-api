import assert from 'node:assert/strict';
import {it} from 'node:test';
import {quotePackageFinancialSnapshot} from '../../administration/services/quotePackageFinance.js';
import {quotePackageInvoiceLines} from './quotePackageInvoice.js';
import {evalTotals} from './evalTotals.js';
import {contributionPolicy, evaluateContributionInvoice} from './socialSecurity.js';
import {reconcileInvoiceEconomics} from './invoiceEconomics.js';

const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const legacyLine = (extra: Record<string, any> = {}): Record<string, any> => ({itemType: 'SERVICE', itemId: id(2), description: 'Fisioterapia concordata',
    quantity: 10, unitPrice: 40, total: 400, vatNature: 'N4', ...extra});
const packageFrom = (lines: any[], extra: Record<string, any> = {}) => ({quoteId: id(1), templateId: null,
    lines, totalPrice: lines.reduce((sum, line) => sum + Number(line.total), 0), ...extra});
function invoice(pack: any, appliesVat = true) {
    const snapshot = quotePackageFinancialSnapshot(pack);
    assert.ok(snapshot);
    const lines = quotePackageInvoiceLines(snapshot.lines, appliesVat);
    const toEval = (line: any) => ({sellingPrice: line.unitPrice, quantity: line.quantity, productVat: line.vat, socialSecurity: line.socialSecurity});
    const fields = {socialSecurityPricingMode: 'NONE' as const, socialSecurityFund: 'NONE' as const, appliesVat,
        products: lines.products.map(toEval), services: lines.services.map(toEval)};
    const totals = evalTotals(fields);
    assert.equal(totals.invoiceNet, pack.totalPrice);
    const fiscalLines = [...lines.products.map(line => ({...line, kind: 'PRODUCT'})), ...lines.services.map(line => ({...line, kind: 'SERVICE'}))];
    const exported = reconcileInvoiceEconomics({...totals, isRivals: false, isTaxWithholding: false,
        isStamp: false, stampChargedToPatient: false}, fiscalLines, appliesVat ? 'RF01' : 'RF19');
    assert.equal(exported.totals.invoiceNet, pack.totalPrice);
    return {lines, totals};
}

it('keeps multiple agreed services, quantities and prices independently from their current catalogue', () => {
    const pack = packageFrom([legacyLine(), legacyLine({itemId: id(3), description: 'Tecarterapia', quantity: 2, unitPrice: 25, total: 50})]);
    const original = JSON.stringify(pack);
    const result = invoice(pack);
    assert.deepEqual(result.lines.services.map(line => [line.name, line.quantity, line.unitPrice]),
        [['Fisioterapia concordata', 10, 40], ['Tecarterapia', 2, 25]]);
    assert.equal(JSON.stringify(pack), original);
});

it('keeps free descriptions and product/custom lines without inventing catalogue identifiers', () => {
    const result = invoice(packageFrom([legacyLine({itemId: null}),
        legacyLine({itemType: 'CUSTOM', itemId: null, description: 'Voce concordata', quantity: 1, unitPrice: 10, total: 10}),
        legacyLine({itemType: 'PRODUCT', itemId: id(4), description: 'Prodotto', quantity: 2, unitPrice: 5, total: 10})]));
    assert.equal(result.lines.services[0].id, null);
    assert.equal(result.lines.products[0].id, null);
    assert.equal(result.lines.products[1].id, id(4));
});

it('reads the immutable purchase quote snapshot and refuses inconsistent or unrelated legacy amounts', () => {
    const saved = legacyLine();
    const pack = packageFrom([legacyLine({unitPrice: 99, total: 990})],
        {totalPrice: 400, purchaseSnapshot: {quote: {id: id(1), total: 400, lines: [saved]}}});
    assert.equal(invoice(pack).lines.services[0].unitPrice, 40);
    for (const invalid of [{...pack, quoteId: null}, {...pack, totalPrice: 401}, packageFrom([]),
        packageFrom([legacyLine({quantity: 1.5, total: 60})]), packageFrom([legacyLine({unitPrice: null})]),
        packageFrom([legacyLine({total: 401})]), packageFrom([legacyLine({itemId: 'invented'})])])
        assert.equal(quotePackageFinancialSnapshot(invalid), null);
});

it('retains quote VAT and the frozen INPS policy with final quoted customer amounts', () => {
    const policy = contributionPolicy('INPS_GS', 'EXCLUDED', 4);
    const modern = (extra: any) => {const line = legacyLine({quantity: 2, unitPrice: 50, vatRate: 22,
        socialSecurity: policy, appliesVat: true, ...extra});
        line.total = evaluateContributionInvoice({policy, lines: [{type: 'SERVICE', sellingPrice: line.unitPrice,
            quantity: line.quantity, productVat: line.vatRate || line.vatNature}]}).invoiceTotal;
        return line;};
    const result = invoice(packageFrom([modern({}), modern({quantity: 3, unitPrice: 20, vatRate: 0})]));
    assert.equal(result.totals.invoiceVAT, 22.88);
    assert.equal(result.totals.rivalsAmount, 6.4);
    assert.equal(result.lines.services[0].socialSecurity?.mode, 'INCLUDED');
});

it('uses the discounted quote tariff and retains the same customer price when the fiscal regime changes', () => {
    const policy = contributionPolicy('INPS_GS', 'EXCLUDED', 4);
    const line = legacyLine({unitPrice: 40, baseUnitPrice: 70, quantity: 10, vatRate: 22,
        appliesVat: false, socialSecurity: policy, total: 416});
    const pack = packageFrom([line]);
    assert.equal(invoice(pack, false).totals.invoiceNet, 416);
    assert.equal(invoice(pack, true).totals.invoiceNet, 416);
    const taxed = {...line, appliesVat: true, total: 507.52};
    assert.equal(invoice(packageFrom([taxed]), false).totals.invoiceNet, 507.52);
});

it('keeps included contributions and separately rounded quote lines at their exact agreed total', () => {
    const policy = contributionPolicy('INPS_GS', 'EXCLUDED', 4);
    const pack = packageFrom([legacyLine({quantity: 1, unitPrice: .13, total: .14, socialSecurity: policy}),
        legacyLine({quantity: 1, unitPrice: .13, total: .14, socialSecurity: policy})]);
    assert.equal(invoice(pack).totals.invoiceNet, .28);
    const included = packageFrom([legacyLine({unitPrice: 40, quantity: 2, total: 80,
        socialSecurity: contributionPolicy('INPS_GS', 'INCLUDED', 4)})]);
    assert.equal(invoice(included).totals.invoiceNet, 80);
});

it('keeps legacy VAT customer totals and represents non-divisible unit cents as one package service line', () => {
    const result = invoice(packageFrom([legacyLine({quantity: 3, unitPrice: 40, total: 120, vatRate: 22})]));
    assert.equal(result.lines.services[0].quantity, 1);
    assert.equal(result.lines.services[0].name, 'Fisioterapia concordata (3 sedute)');
    assert.equal(result.totals.invoiceNet, 120);
    assert.equal(result.totals.invoiceVAT, 21.64);
    const twoUnits = invoice(packageFrom([legacyLine({quantity: 2, unitPrice: 50, total: 100, vatRate: 22})]));
    assert.equal(twoUnits.lines.services.length, 1);
    assert.equal(twoUnits.lines.services[0].name, 'Fisioterapia concordata (2 sedute)');
    assert.equal(twoUnits.totals.invoiceNet, 100);
});

it('preserves fractional product quantities as an agreed descriptive line supported by the invoice schema', () => {
    const result = invoice(packageFrom([legacyLine(), legacyLine({itemType: 'PRODUCT', quantity: 1.5, unitPrice: 10,
        total: 15, description: 'Materiale', itemId: null})]));
    assert.equal(result.lines.products[0].quantity, 1);
    assert.equal(result.lines.products[0].name, 'Materiale (1.5)');
    assert.equal(result.lines.products[0].unitPrice, 15);
});

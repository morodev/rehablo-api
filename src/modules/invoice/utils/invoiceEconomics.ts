import {ContributionPolicy, ContributionSnapshot, contributionPolicy, evaluateContributionInvoice} from './socialSecurity.js';
import { evalTotalsDetailed, invoiceAmountInCents as cents, roundInvoiceAmount as money } from './evalTotals.js';
import { getTaxRegime, isTaxRegimeCode } from './fiscalRegime.js';

type Decimal = number | string | null;
export interface FrozenEconomicLine {
    socialSecurity?: ContributionPolicy | null;
    kind?: string;
    unitPrice: Decimal;
    quantity: Decimal;
    vat: string | null;
    /** Optional consistency checks for stored line snapshots. */
    totalPrice?: Decimal;
    percentageDiscount?: Decimal;
    discountAmount?: Decimal;
}
export interface FrozenEconomicDocument {
    socialSecuritySnapshot?: ContributionSnapshot | null;
    discountType?: string | null;
    discountAmount?: Decimal;
    discSellingPrice?: Decimal;
    invoiceVAT?: Decimal;
    invoiceTotal?: Decimal;
    invoiceNet?: Decimal;
    isRivals?: boolean;
    rivals?: Decimal;
    isCashPro?: boolean;
    isTaxWithholding?: boolean;
    taxWithholding?: Decimal;
    vatNature?: string | null;
    isStamp?: boolean;
    stampAmount?: Decimal;
    stampChargedToPatient?: boolean;
}

export class FiscalExportError extends Error {
    readonly statusCode = 422;
    constructor(readonly code: string, message: string) { super(`${code}: ${message}`); }
}
const fail = (code: string, message: string): never => { throw new FiscalExportError(code, message); };
const amount = (value: unknown, field: string, required = true): number => {
    if (value == null || (typeof value === 'string' && !value.trim())) {
        if (required) fail('INCOMPLETE_FISCAL_SNAPSHOT', `Manca ${field} nel documento congelato.`);
        return 0;
    }
    if (typeof value !== 'number' && typeof value !== 'string') fail('INVALID_FISCAL_SNAPSHOT', `${field} non valido.`);
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) fail('INVALID_FISCAL_SNAPSHOT', `${field} non valido.`);
    return parsed;
};
const compare = (calculated: number, stored: unknown, field: string) => {
    const expected = amount(stored, field);
    if (cents(calculated) !== cents(expected)) {
        fail('FISCAL_TOTAL_MISMATCH', `${field}: documento ${expected.toFixed(2)}, ricostruzione ${calculated.toFixed(2)}.`);
    }
};
const validNature = (value: string) => /^(N1|N2\.[12]|N3\.[1-6]|N4|N5|N6\.[1-9]|N7)$/.test(value);

/** Strict export interpretation. Unlike legacy persistence, unknown VAT is never guessed as exempt. */
function effectiveVat(raw: string | null, taxRegime: string, documentNature?: string | null) {
    const regime = getTaxRegime(taxRegime);
    if (!regime.appliesVat) return { vatRate: 0, natura: regime.forcedVatNature! };
    const value = String(raw ?? '').trim().toUpperCase();
    if (['4', '5', '10', '22'].includes(value)) return { vatRate: Number(value), natura: null };
    const nature = validNature(value) ? value
        : ['', '0', 'ESENTE', 'ES'].includes(value) ? String(documentNature ?? '').trim().toUpperCase() : '';
    if (!validNature(nature)) fail('INCOMPLETE_FISCAL_SNAPSHOT', `Natura IVA mancante o non supportata per la riga (${value || 'vuota'}).`);
    return { vatRate: 0, natura: nature };
}

/** Allocate only the document discount, keeping its rounded aggregate exact. */
function allocateBases(values: number[], target: number): number[] {
    const rows = values.map((value, index) => ({ index, exact: value * 100, units: Math.floor(value * 100 + 1e-8) }));
    const remainder = cents(target) - rows.reduce((sum, row) => sum + row.units, 0);
    if (remainder < 0 || remainder > rows.length) fail('UNREPRESENTABLE_FISCAL_ROUNDING', 'Sconto non ripartibile sulle righe.');
    const order = [...rows].sort((a, b) => (b.exact - b.units) - (a.exact - a.units) || a.index - b.index);
    for (let i = 0; i < remainder; i++) order[i].units++;
    return rows.map(row => row.units / 100);
}

/**
 * Reconstructs export economics exclusively from frozen invoice data. Never updates a document,
 * reads current tenant/catalog settings, or changes stored payment/rounding semantics.
 * Missing contribution/withholding classification is deliberately not inferred from booleans.
 */
export function reconcileInvoiceEconomics(document: FrozenEconomicDocument, lines: FrozenEconomicLine[], taxRegime: unknown) {
    if (!isTaxRegimeCode(taxRegime)) fail('INCOMPLETE_FISCAL_SNAPSHOT', 'Regime fiscale congelato mancante o non riconosciuto.');
    if (!lines.length) fail('INCOMPLETE_FISCAL_SNAPSHOT', 'Il documento non contiene righe congelate.');
    for (const flag of ['isRivals', 'isCashPro', 'isTaxWithholding', 'isStamp', 'stampChargedToPatient'] as const) {
        if (document[flag] != null && typeof document[flag] !== 'boolean') fail('INVALID_FISCAL_SNAPSHOT', `${flag} non valido.`);
    }
    if (document.socialSecuritySnapshot) {
        const snapshot = document.socialSecuritySnapshot;
        if (snapshot.version !== 1 || !Array.isArray(snapshot.lines) || snapshot.lines.length !== lines.length)
            fail('INCOMPLETE_FISCAL_SNAPSHOT', 'Snapshot previdenziale incompleto.');
        const unassigned = [...snapshot.lines];
        const ordered = lines.map(line => {
            const vat = effectiveVat(line.vat, String(taxRegime), document.vatNature);
            const policy = line.socialSecurity ?? (line.kind === 'PRODUCT' ? contributionPolicy('NONE') : snapshot.policy);
            const index = unassigned.findIndex(saved => saved.policy.mode === policy.mode && saved.policy.fund === policy.fund
                && Number(saved.policy.rate) === Number(policy.rate) && saved.kind === line.kind && Number(saved.unitPrice) === Number(line.unitPrice)
                && Number(saved.quantity) === Number(line.quantity) && saved.vatRate === vat.vatRate
                && (vat.vatRate > 0 || saved.vatKey === vat.natura));
            if (index < 0) fail('INVALID_FISCAL_SNAPSHOT', 'Righe diverse dallo snapshot economico.');
            const [saved] = unassigned.splice(index, 1);
            if (line.totalPrice != null) compare(money(Number(line.unitPrice) * Number(line.quantity)), line.totalPrice, 'totalPrice');
            return saved;
        });
        const calculated = evaluateContributionInvoice({policy: snapshot.policy,
            lines: snapshot.lines.map(line => ({type: line.kind, sellingPrice: line.unitPrice, quantity: line.quantity,
                productVat: line.vatKey, socialSecurity: line.policy})),
            discountType: document.discountType, discountAmount: Number(document.discountAmount ?? 0),
            appliesVat: getTaxRegime(String(taxRegime)).appliesVat,
            isTaxWithholding: !!snapshot.withholding, taxWithholding: snapshot.withholding?.rate,
            withholdingType: snapshot.withholding?.type, withholdingCausale: snapshot.withholding?.causale,
            isStamp: document.isStamp, stampAmount: Number(document.stampAmount ?? 0), stampChargedToPatient: document.stampChargedToPatient});
        for (const field of ['discSellingPrice', 'invoiceVAT', 'invoiceTotal', 'invoiceNet'] as const) compare(calculated[field], document[field], field);
        snapshot.lines.forEach((line, index) => {
            for (const field of ['base', 'contribution', 'vat', 'customerAmount'] as const)
                compare(calculated.socialSecuritySnapshot.lines[index][field], line[field], field);
        });
        if (!Number.isFinite(snapshot.rounding) || cents(calculated.socialSecuritySnapshot.rounding) !== cents(snapshot.rounding))
            fail('FISCAL_TOTAL_MISMATCH', 'Arrotondamento congelato non riconciliato.');
        if (snapshot.withholding && (!['RT01', 'RT02'].includes(snapshot.withholding.type ?? '') || snapshot.withholding.causale !== 'A'))
            fail('INCOMPLETE_FISCAL_SNAPSHOT', 'Tipo e causale della ritenuta mancanti.');
        const contributions = new Map<string, {tipoCassa: string; aliquota: number; base: number; amount: number; vatRate: number; natura: string | null; withholding: boolean}>();
        for (const line of snapshot.lines) {
            if (!line.contribution) continue;
            if (line.policy.fund !== 'INPS_GS') fail('UNSUPPORTED_FISCAL_METADATA', 'Codice cassa professionale non congelato sul documento.');
            const key = line.vatRate + ':' + line.vatKey;
            const group = contributions.get(key) ?? {tipoCassa: 'TC22', aliquota: 4, base: 0, amount: 0,
                vatRate: line.vatRate, natura: line.vatRate ? null : line.vatKey, withholding: !!snapshot.withholding};
            group.base = money(group.base + line.base); group.amount = money(group.amount + line.contribution);
            contributions.set(key, group);
        }
        return {totals: calculated, contributions: [...contributions.values()], withholding: snapshot.withholding, rounding: snapshot.rounding,
            lines: ordered.map((line, index) => {
                const reference = snapshot.lines.reduce((sum, value) => sum + value.referenceAmount, 0);
                const reduction = document.discountType === 'percentage' ? Number(document.discountAmount ?? 0) / 100
                    : document.discountType === 'value' && reference ? Number(document.discountAmount ?? 0) / reference : 0;
                // Included contribution is a separate charge, never a fictitious line discount.
                const unitPrice = line.policy.mode === 'INCLUDED' ? line.base / Number(lines[index].quantity) / (1 - reduction) : Number(lines[index].unitPrice);
                return {unitPrice, quantity: Number(lines[index].quantity), vatRate: line.vatRate,
                    withholding: !!snapshot.withholding && line.kind === 'SERVICE',
                    natura: line.vatRate ? null : line.vatKey, netAmount: line.base,
                    discountUnitAmount: reduction ? unitPrice - line.base / Number(lines[index].quantity) : 0};
            })};
    }
    if (document.isRivals || document.isTaxWithholding) {
        fail('UNSUPPORTED_FISCAL_METADATA', 'Contributo o ritenuta attivi: i codici fiscali necessari non sono congelati sul documento.');
    }
    const type = document.discountType || undefined;
    const discountAmount = amount(document.discountAmount, 'discountAmount', false);
    if ((type && type !== 'percentage' && type !== 'value') || (discountAmount > 0 && !type)) {
        fail('INVALID_FISCAL_SNAPSHOT', 'Tipo di sconto documento mancante o non supportato.');
    }
    const normalized = lines.map((line, index) => {
        const unitPrice = amount(line.unitPrice, `righe[${index}].unitPrice`);
        const quantity = amount(line.quantity, `righe[${index}].quantity`);
        if (!Number.isInteger(quantity) || quantity <= 0) fail('INVALID_FISCAL_SNAPSHOT', 'Quantità non intera o non positiva.');
        if (amount(line.percentageDiscount, 'percentageDiscount', false) !== 0 || amount(line.discountAmount, 'line.discountAmount', false) !== 0) {
            fail('UNSUPPORTED_FISCAL_METADATA', 'Sconti di riga legacy non rappresentabili senza una semantica congelata.');
        }
        if (line.totalPrice != null) compare(money(unitPrice * quantity), line.totalPrice, `righe[${index}].totalPrice`);
        return { unitPrice, quantity, ...effectiveVat(line.vat, String(taxRegime), document.vatNature) };
    });
    const subtotal = money(normalized.reduce((sum, line) => sum + money(line.unitPrice * line.quantity), 0));
    if ((type === 'percentage' && discountAmount >= 100) || (type === 'value' && discountAmount >= subtotal)) {
        fail('INVALID_FISCAL_SNAPSHOT', 'Sconto documento fuori intervallo.');
    }
    if (document.isStamp && typeof document.stampChargedToPatient !== 'boolean') {
        fail('INCOMPLETE_FISCAL_SNAPSHOT', 'Modalità di riaddebito del bollo non congelata.');
    }
    const stampAmount = document.isStamp ? amount(document.stampAmount, 'stampAmount') : 0;
    if (document.isStamp && stampAmount <= 0) fail('INVALID_FISCAL_SNAPSHOT', 'Importo del bollo non positivo.');
    const calculation = evalTotalsDetailed({
        products: normalized.map(line => ({ sellingPrice: line.unitPrice, quantity: line.quantity,
            productVat: line.vatRate || 'N4' })),
        discountType: type as 'percentage' | 'value' | undefined, discountAmount,
        appliesVat: getTaxRegime(String(taxRegime)).appliesVat,
        isStamp: document.isStamp, stampAmount, stampChargedToPatient: document.stampChargedToPatient
    });
    for (const field of ['discSellingPrice', 'invoiceVAT', 'invoiceTotal', 'invoiceNet'] as const) {
        compare(calculation.totals[field], document[field], field);
    }
    const bases = allocateBases(calculation.lines.map(line => line.discountedPrice), calculation.totals.discSellingPrice);
    const summaries = new Map<string, { base: number; tax: number; rate: number }>();
    normalized.forEach((line, index) => {
        const key = `${line.vatRate}:${line.natura ?? ''}`;
        const summary = summaries.get(key) ?? { base: 0, tax: 0, rate: line.vatRate };
        summary.base = money(summary.base + bases[index]);
        summary.tax = money(summary.tax + calculation.lines[index].vatAmount);
        summaries.set(key, summary);
    });
    for (const summary of summaries.values()) {
        if (cents((summary.rate / 100) * summary.base) !== cents(summary.tax)) {
            fail('UNREPRESENTABLE_FISCAL_ROUNDING', 'IVA arrotondata per riga diversa dal riepilogo per aliquota: nessun importo del documento è stato modificato.');
        }
    }
    return { contributions: [], withholding: null, rounding: 0, totals: calculation.totals, lines: normalized.map((line, index) => ({
        ...line, netAmount: bases[index],
        discountUnitAmount: (money(line.unitPrice * line.quantity) - bases[index]) / line.quantity
    })) };
}

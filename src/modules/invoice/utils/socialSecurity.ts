/** Mirrored in rehablo-api: pure, versioned economics for newly agreed prices only. */
export type SocialSecurityPricingMode = 'NONE' | 'EXCLUDED' | 'INCLUDED';
export interface ContributionPolicy {
    mode: SocialSecurityPricingMode;
    fund: 'NONE' | 'INPS_GS' | 'CASSA';
    rate: number;
}
export const SOCIAL_SECURITY_MODES = [
    {value: 'NONE' as const, label: 'Non applicata'},
    {value: 'EXCLUDED' as const, label: 'Aggiunta al prezzo'},
    {value: 'INCLUDED' as const, label: 'Già compresa nel prezzo'}
];
export const fiscalMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
export function contributionPolicy(fund: unknown, mode: unknown = 'EXCLUDED', rate: unknown = 4): ContributionPolicy {
    const resolvedFund = fund === 'INPS_GS' || fund === 'CASSA' ? fund : 'NONE';
    if (!['NONE', 'EXCLUDED', 'INCLUDED'].includes(String(mode))) throw new Error('Modalità rivalsa non valida');
    const resolvedRate = resolvedFund === 'INPS_GS' ? 4 : Number(rate);
    if (!Number.isFinite(resolvedRate) || resolvedRate < 0 || resolvedRate > 100) throw new Error('Aliquota previdenziale non valida');
    return {fund: resolvedFund, mode: resolvedFund === 'NONE' ? 'NONE' : mode as SocialSecurityPricingMode, rate: resolvedRate};
}
export interface ContributionLineInput {
    sellingPrice: number;
    originalSellingPrice?: number | null;
    quantity?: number | null;
    productVat?: string | number | null;
    type?: string;
    socialSecurity?: ContributionPolicy | null;
}
export interface ContributionInvoiceInput {
    lines: ContributionLineInput[];
    policy: ContributionPolicy;
    appliesVat?: boolean;
    discountType?: string | null;
    discountAmount?: number | null;
    isTaxWithholding?: boolean;
    taxWithholding?: number | null;
    withholdingType?: string | null;
    withholdingCausale?: string | null;
    isStamp?: boolean;
    stampAmount?: number | null;
    stampChargedToPatient?: boolean;
}
export interface ContributionLineSnapshot {
    kind: string;
    unitPrice: number;
    quantity: number;
    referenceAmount: number;
    discountedReferenceAmount: number;
    base: number;
    contribution: number;
    vatRate: number;
    vatKey: string;
    vat: number;
    customerAmount: number;
    policy: ContributionPolicy;
}
export interface ContributionSnapshot {
    version: 1;
    rounding: number;
    policy: ContributionPolicy;
    lines: ContributionLineSnapshot[];
    withholding: {type: string | null; causale: string | null; rate: number; amount: number} | null;
}

/** Largest-remainder allocation preserves the agreed document amount to the cent. */
export function allocateFiscalCents(exact: number[], target = fiscalMoney(exact.reduce((sum, value) => sum + value, 0))): number[] {
    const rows = exact.map((value, index) => ({index, exact: value * 100, cents: Math.floor(value * 100 + 1e-7)}));
    let remainder = Math.round(target * 100) - rows.reduce((sum, row) => sum + row.cents, 0);
    const ranked = [...rows].sort((a, b) => (b.exact - b.cents) - (a.exact - a.cents) || a.index - b.index);
    for (let i = 0; remainder > 0 && ranked.length; i++, remainder--) ranked[i % ranked.length].cents++;
    return rows.map(row => row.cents / 100);
}

/** Reference compensation follows the same fiscal groups as the discounted contribution. */
export function undiscountedCompensation(lines: Pick<ContributionLineSnapshot, 'referenceAmount' | 'policy' | 'vatKey'>[]): number[] {
    const bases = lines.map(line => line.referenceAmount);
    const groups = new Map<string, number[]>();
    lines.forEach((line, index) => {
        if (line.policy.mode !== 'INCLUDED') return;
        const key = `${line.policy.fund}:${line.policy.rate}:${line.vatKey}`;
        groups.set(key, [...(groups.get(key) ?? []), index]);
    });
    for (const indexes of groups.values()) {
        const allocated = allocateFiscalCents(indexes.map(index => {
            const line = lines[index];
            return line.referenceAmount - line.referenceAmount / (1 + line.policy.rate / 100);
        }));
        indexes.forEach((index, offset) => bases[index] = fiscalMoney(bases[index] - allocated[offset]));
    }
    return bases;
}

export function evaluateContributionInvoice(input: ContributionInvoiceInput) {
    const money = fiscalMoney;
    const amounts = input.lines.map(line => money(Number(line.sellingPrice) * Number(line.quantity ?? 1)));
    const referenceSubtotal = money(amounts.reduce((sum, value) => sum + value, 0));
    const discountValue = Number(input.discountAmount ?? 0);
    const discountFactor = input.discountType === 'percentage' ? discountValue / 100
        : input.discountType === 'value' && referenceSubtotal ? discountValue / referenceSubtotal : 0;
    const discounted = allocateFiscalCents(amounts.map(value => value * (1 - discountFactor)));
    const policies = input.lines.map(line => {
        const policy = line.socialSecurity ?? (line.type === 'PRODUCT' || line.type === 'CUSTOM'
            ? contributionPolicy('NONE') : input.policy);
        return contributionPolicy(policy.fund, policy.mode, policy.rate);
    });
    const exactContributions = discounted.map((value, index) => {
        const policy = policies[index];
        const base = policy.mode === 'INCLUDED' ? value / (1 + policy.rate / 100) : value;
        return policy.mode === 'NONE' ? 0 : policy.mode === 'INCLUDED' ? value - base : base * policy.rate / 100;
    });
    // Allocate separately by fiscal treatment so every XML contribution group reconciles.
    const contributions = exactContributions.map(() => 0);
    const groups = new Map<string, number[]>();
    input.lines.forEach((line, index) => {
        const policy = policies[index];
        const key = `${policy.fund}:${policy.rate}:${policy.mode}:${input.appliesVat !== false ? String(line.productVat ?? 'N4').trim().toUpperCase() : 'N2.2'}`;
        groups.set(key, [...(groups.get(key) ?? []), index]);
    });
    for (const indexes of groups.values()) {
        const allocated = allocateFiscalCents(indexes.map(index => exactContributions[index]));
        indexes.forEach((index, offset) => contributions[index] = allocated[offset]);
    }
    const lines: ContributionLineSnapshot[] = input.lines.map((line, index) => {
        const policy = policies[index];
        const base = policy.mode === 'INCLUDED' ? money(discounted[index] - contributions[index]) : discounted[index];
        const rawVat = String(line.productVat ?? 'N4').trim().toUpperCase();
        const vatRate = input.appliesVat !== false && ['4', '5', '10', '22'].includes(rawVat) ? Number(rawVat) : 0;
        const vat = money((base + contributions[index]) * vatRate / 100);
        return {kind: line.type ?? 'SERVICE', unitPrice: Number(line.sellingPrice), quantity: Number(line.quantity ?? 1),
            referenceAmount: amounts[index], discountedReferenceAmount: discounted[index], base,
            contribution: contributions[index], vatRate, vatKey: input.appliesVat === false ? 'N2.2' : vatRate ? String(vatRate) : rawVat.startsWith('N') ? rawVat : 'N4',
            vat, customerAmount: money(base + contributions[index] + vat), policy};
    });
    const sum = (pick: (line: ContributionLineSnapshot) => number) => money(lines.reduce((total, line) => total + pick(line), 0));
    const stampChargedAmount = input.isStamp && input.stampChargedToPatient ? Number(input.stampAmount ?? 0) : 0;
    const taxWithholdingAmount = input.isTaxWithholding ? money(sum(line => line.kind === 'SERVICE' ? line.base +
        (line.policy.fund === 'INPS_GS' ? line.contribution : 0) : 0) * Number(input.taxWithholding ?? 0) / 100) : 0;
    const invoiceTotal = money(sum(line => line.customerAmount) + stampChargedAmount);
    const taxableGroups = new Map<string, {base: number; rate: number}>();
    lines.forEach(line => {
        const key = `${line.vatRate}:${line.vatKey}`;
        const group = taxableGroups.get(key) ?? {base: 0, rate: line.vatRate};
        group.base = money(group.base + line.base + line.contribution);
        taxableGroups.set(key, group);
    });
    const invoiceVAT = money([...taxableGroups.values()].reduce((total, group) => total + money(group.base * group.rate / 100), 0));
    const rounding = money(invoiceTotal - sum(line => line.base + line.contribution) - invoiceVAT - stampChargedAmount);
    const adjustedSubtotal = money(undiscountedCompensation(lines).reduce((total, amount) => total + amount, 0));
    const originalSubtotal = money(undiscountedCompensation(lines.map((line, index) => ({...line,
        referenceAmount: money(Number(input.lines[index].originalSellingPrice ?? line.unitPrice) * line.quantity)
    }))).reduce((total, amount) => total + amount, 0));
    const vatBuckets = new Map<string, number>();
    lines.forEach(line => {if (line.vat) vatBuckets.set(String(line.vatRate), money((vatBuckets.get(String(line.vatRate)) ?? 0) + line.vat));});
    const snapshot: ContributionSnapshot = {version: 1, rounding, policy: input.policy, lines,
        withholding: input.isTaxWithholding ? {type: input.withholdingType ?? null, causale: input.withholdingCausale ?? null,
            rate: Number(input.taxWithholding ?? 0), amount: taxWithholdingAmount} : null};
    return {
        sellingPrice: originalSubtotal, adjustedSubtotal,
        discSellingPrice: sum(line => line.base), appointmentDiscountTotal: money(Math.max(originalSubtotal - adjustedSubtotal, 0)),
        documentDiscountTotal: money(Math.max(adjustedSubtotal - sum(line => line.base), 0)),
        discountTotal: money(Math.max(originalSubtotal - sum(line => line.base), 0)),
        invoiceVAT, invoiceTotal, invoiceNet: money(invoiceTotal - taxWithholdingAmount),
        vatFreeAmount: sum(line => line.vatRate === 0 ? line.base + line.contribution : 0),
        rivalsAmount: sum(line => line.contribution), taxWithholdingAmount, stampChargedAmount,
        vatBreakdown: [...vatBuckets].map(([vatKey, amount]) => ({vatKey, amount})), socialSecuritySnapshot: snapshot
    };
}

import { balanceEffectiveMovements } from '../../administration/services/treasuryLedger.service.js';

type Row = Record<string, any>;
export interface FinancialWarning { code: string; message: string; count?: number; }
export interface ClinicalCashFact extends Row {
    id: string; sourceId: string; paymentId: string; amount: number;
    paidAt: unknown; kind: 'receipt' | 'reversal' | 'refund';
}
const money = (value: unknown) => Math.round((Number(value) || 0) * 100) / 100;
const cashSource = (row: Row) => !['PACKAGE', 'CREDIT', 'OPENING_BALANCE'].includes(row.source);

/** A read projection only: never repairs dates, writes a mirror, or guesses a refund. */
export function clinicalCashFacts(payments: Row[], movements: Row[] = [], credits: Row[] = [], creditMovements: Row[] = []) {
    const effective = balanceEffectiveMovements(movements);
    const originals = new Map(effective.filter(row => ['INVOICE_PAYMENT', 'INVOICE_PAYMENT_CORRECTION'].includes(row.sourceType) && row.direction === 'IN')
        .sort((left, right) => Number(left.sourceType === 'INVOICE_PAYMENT_CORRECTION') - Number(right.sourceType === 'INVOICE_PAYMENT_CORRECTION'))
        .map(row => [String(row.sourceId), row]));
    const facts: ClinicalCashFact[] = [];
    const warnings: FinancialWarning[] = [];
    let undated = 0, ambiguous = 0, unmatched = 0, differingDates = 0;
    const seen = new Set<string>();
    for (const payment of payments) {
        if (seen.has(payment.id) || !cashSource(payment)) continue;
        seen.add(payment.id);
        const original = originals.get(String(payment.id));
        const reversals = original ? effective.filter(row => row.reversalOfId === original.id && row.direction === 'OUT'
            && row.accountId === original.accountId && money(row.amount) === money(original.amount)) : [];
        const verified = original && money(original.amount) === money(payment.amount);
        if (payment.status === 'VOID' && (!verified || !reversals.length)) { ambiguous++; continue; }
        if (!['POSTED', 'CREDIT', 'VOID'].includes(payment.status)) continue;
        if (!payment.paidAt) undated++;
        if (!verified) unmatched++;
        if (verified && payment.paidAt && dateOnly(payment.paidAt) !== dateOnly(original.occurredAt)) differingDates++;
        const receipt: ClinicalCashFact = { ...payment, id: `payment:${payment.id}`, sourceId: payment.id, paymentId: payment.id,
            amount: money(payment.amount), paidAt: payment.paidAt ?? null, kind: 'receipt' };
        facts.push(receipt);
        for (const reversal of reversals) {
            facts.push({ ...receipt, id: `treasury:${reversal.id}`, sourceId: reversal.id,
                amount: -money(reversal.amount), paidAt: reversal.occurredAt, kind: 'reversal' });
        }
        const retained = credits.filter(credit => credit.sourceType === 'VOID_CREDIT' && credit.sourceId === payment.id);
        for (const credit of retained) {
            for (const refund of creditMovements.filter(row => row.creditId === credit.id && row.type === 'REFUND')) {
                const cash = effective.find(row => row.id === refund.treasuryMovementId && row.direction === 'OUT'
                    && row.sourceType === 'PATIENT_CREDIT_REFUND' && row.sourceId === refund.id
                    && money(row.amount) === money(refund.amount));
                if (!cash) continue;
                facts.push({ ...receipt, id: `treasury:${cash.id}`, sourceId: cash.id,
                    amount: -money(cash.amount), paidAt: cash.occurredAt, kind: 'refund' });
                for (const reverse of creditMovements.filter(row => row.creditId === credit.id && row.type === 'REVERSE_REFUND'
                    && row.reversalOfId === refund.id && money(row.amount) === money(refund.amount))) {
                    const restored = effective.find(row => row.id === reverse.treasuryMovementId && row.direction === 'IN'
                        && row.sourceType === 'PATIENT_REFUND_VOID' && row.sourceId === refund.id
                        && row.reversalOfId === cash.id && row.accountId === cash.accountId && money(row.amount) === money(cash.amount));
                    if (restored) facts.push({...receipt, id: `treasury:${restored.id}`, sourceId: restored.id,
                        amount: money(restored.amount), paidAt: restored.occurredAt, kind: 'refund'});
                }
            }
        }
    }
    if (undated) warnings.push({ code: 'undated-payments', count: undated, message: 'Incassi senza data esclusi dagli andamenti del periodo.' });
    if (ambiguous) warnings.push({ code: 'legacy-void', count: ambiguous, message: 'Annullamenti precedenti senza controregistrazione verificabile, esclusi dagli incassi.' });
    if (unmatched) warnings.push({ code: 'unmirrored-payments', count: unmatched, message: 'Incassi clinici senza una registrazione di tesoreria verificata.' });
    if (differingDates) warnings.push({ code: 'cash-date-mismatch', count: differingDates, message: 'Date degli incassi clinici e della tesoreria da riconciliare; le date originali sono conservate.' });
    const reversalCount = facts.filter(row => row.kind === 'reversal').length;
    if (reversalCount) warnings.push({ code: 'legacy-reversal-kind', count: reversalCount,
        message: 'Le rettifiche precedenti non distinguono un errore di registrazione da una restituzione reale.' });
    return { facts, warnings };
}

export function dateOnly(value: unknown): string {
    if (!value) return '';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const date = new Date(value as string);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export function inFinancialPeriod(value: unknown, from: string, to: string): boolean {
    const date = dateOnly(value);
    return !!date && date >= from && date <= to;
}
export function validIssuedDocument(row: Row): boolean {
    return !!row.emissionDate && (!row.documentType || ['fattura', 'ricevuta', 'nota_di_credito'].includes(row.documentType))
        && !['void', 'draft', 'cancelled'].includes(String(row.status ?? '').toLowerCase());
}
export const documentSign = (row: Row) => row.documentType === 'nota_di_credito' ? -1 : 1;

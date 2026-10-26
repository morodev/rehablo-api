import { balanceEffectiveMovements } from '../../administration/services/treasuryLedger.service.js';

type Row = Record<string, any>;
export interface FinancialWarning {
    code: string; message: string; count?: number;
    drilldown?: {dataset: 'financial-diagnostics'; filters: Record<string, unknown>};
}
export const CASH_DIAGNOSTIC_CODES = ['legacy-void', 'unmirrored-payments', 'undated-payments', 'cash-date-mismatch', 'legacy-reversal-kind'] as const;
export type CashDiagnosticCode = typeof CASH_DIAGNOSTIC_CODES[number];
export interface CashDiagnosticIssue {
    id: string; issueCode: CashDiagnosticCode; payment: Row; reasonCode: string; reason: string;
    treasuryMovementId?: string; treasuryDate?: unknown; treasuryAmount?: number;
}
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
    const issues: CashDiagnosticIssue[] = [];
    const issue = (issueCode: CashDiagnosticCode, payment: Row, reasonCode: string, reason: string, treasuryMovementId?: string) => {
        const movement = treasuryMovementId ? effective.find(row => row.id === treasuryMovementId) : undefined;
        issues.push({id: `${issueCode}:${treasuryMovementId ?? payment.id}`, issueCode, payment, reasonCode, reason,
            ...(treasuryMovementId ? {treasuryMovementId, treasuryDate: movement?.occurredAt, treasuryAmount: movement ? money(movement.amount) : undefined} : {})});
    };
    const seen = new Set<string>();
    for (const payment of payments) {
        if (seen.has(payment.id) || !cashSource(payment)) continue;
        seen.add(payment.id);
        const original = originals.get(String(payment.id));
        const reversals = original ? effective.filter(row => row.reversalOfId === original.id && row.direction === 'OUT'
            && row.accountId === original.accountId && money(row.amount) === money(original.amount)) : [];
        const verified = original && money(original.amount) === money(payment.amount);
        if (payment.status === 'VOID' && (!verified || !reversals.length)) {
            issue('legacy-void', payment, !original ? 'missing-receipt' : !verified ? 'receipt-amount-mismatch' : 'missing-verified-reversal',
                !original ? 'Entrata di tesoreria originale assente.' : !verified ? 'Importo della registrazione originale diverso dall’incasso.' : 'Controregistrazione di annullamento non verificata.', original?.id);
            continue;
        }
        if (!['POSTED', 'CREDIT', 'VOID'].includes(payment.status)) continue;
        if (!payment.paidAt) issue('undated-payments', payment, 'missing-payment-date', 'Data dell\u2019incasso non registrata.');
        if (!verified) issue('unmirrored-payments', payment, original ? 'receipt-amount-mismatch' : 'missing-receipt',
            original ? 'Importo della prima nota diverso dall\u2019incasso clinico.' : 'Entrata di prima nota assente o non verificabile.', original?.id);
        if (verified && payment.paidAt && dateOnly(payment.paidAt) !== dateOnly(original.occurredAt)) {
            issue('cash-date-mismatch', payment, 'payment-treasury-date-mismatch', 'Data dell\u2019incasso diversa dalla data della prima nota.', original.id);
        }
        const receipt: ClinicalCashFact = { ...payment, id: `payment:${payment.id}`, sourceId: payment.id, paymentId: payment.id,
            amount: money(payment.amount), paidAt: payment.paidAt ?? null, kind: 'receipt' };
        facts.push(receipt);
        for (const reversal of reversals) {
            issue('legacy-reversal-kind', payment, 'unclassified-reversal', 'La rettifica storica non distingue una correzione da una restituzione reale.', reversal.id);
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
    const count = (code: CashDiagnosticCode) => issues.filter(issue => issue.issueCode === code).length;
    const undated = count('undated-payments'), ambiguous = count('legacy-void'), unmatched = count('unmirrored-payments'), differingDates = count('cash-date-mismatch');
    if (undated) warnings.push({ code: 'undated-payments', count: undated, message: 'Incassi senza data esclusi dagli andamenti del periodo.' });
    if (ambiguous) warnings.push({ code: 'legacy-void', count: ambiguous, message: 'Annullamenti precedenti senza controregistrazione verificabile, esclusi dagli incassi.' });
    if (unmatched) warnings.push({ code: 'unmirrored-payments', count: unmatched, message: 'Incassi clinici senza una registrazione di tesoreria verificata.' });
    if (differingDates) warnings.push({ code: 'cash-date-mismatch', count: differingDates, message: 'Date degli incassi clinici e della tesoreria da riconciliare; le date originali sono conservate.' });
    const reversalCount = count('legacy-reversal-kind');
    if (reversalCount) warnings.push({ code: 'legacy-reversal-kind', count: reversalCount,
        message: 'Le rettifiche precedenti non distinguono un errore di registrazione da una restituzione reale.' });
    return { facts, warnings, issues };
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

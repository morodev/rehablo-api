import {createHash} from 'node:crypto';

type Row = Record<string, any>;
export type TreasuryIntegrityKind = 'MISSING_RECEIPT' | 'MISSING_REVERSAL' | 'AMOUNT_MISMATCH'
    | 'DATE_MISMATCH' | 'DUPLICATE_RECEIPT' | 'ORPHAN_ACCOUNT' | 'UNEXPECTED_RECEIPT' | 'LEGACY_EXPENSE'
    | 'CREDIT_LINK_MISSING' | 'TRANSFER_MISMATCH' | 'LEGACY_PURCHASE_DOCUMENT' | 'SETTLEMENT_ALLOCATION_MISMATCH';
export interface TreasuryIntegrityIssue {
    id: string; kind: TreasuryIntegrityKind; title: string; description: string;
    amount: number; structureId: string; paymentId?: string; movementId?: string; expenseId?: string;
    invoiceId?: string | null; agendaEventId?: string | null; carePackageId?: string | null;
    paidAt?: string | null; evidenceVersion: string; settlementOperationId?: string;
    repair: 'RECEIPT' | 'REVERSAL' | null; needsAccount: boolean; needsDate: boolean;
}
export function integrityDate(value: unknown): string | null {
    if (!value) return null;
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const date = new Date(value as string);
    if (!Number.isFinite(date.getTime())) return null;
    return new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit'}).format(date);
}
export function integrityVersion(rows: unknown[]): string {
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
const money = (value: unknown) => Math.round(Number(value) * 100) / 100;
const NON_CASH = new Set(['PACKAGE', 'CREDIT', 'OPENING_BALANCE']);

/** Pure diagnostic: it never invents an account/date and never mutates its inputs. */
export function analyzeTreasuryIntegrity(payments: Row[], movements: Row[], accountIds: string[], expenses: Row[] = [],
    credits: Row[] = [], creditMovements: Row[] = [], purchaseDocuments: Row[] = [], settlementOperations: Row[] = []) {
    const issues: TreasuryIntegrityIssue[] = [];
    const accounts = new Set(accountIds);
    const add = (kind: TreasuryIntegrityKind, row: Row, data: Partial<TreasuryIntegrityIssue>, evidence: unknown[]) => {
        issues.push({id: `${kind}:${row.id}`, kind, title: '', description: '', amount: money(row.amount),
            structureId: String(row.structureId ?? ''), evidenceVersion: integrityVersion(evidence),
            repair: null, needsAccount: false, needsDate: false, ...data});
    };
    for (const payment of payments) {
        const corrections = movements.filter(row => row.sourceType === 'INVOICE_PAYMENT_CORRECTION' && row.sourceId === payment.id && row.direction === 'IN');
        const receipts = corrections.length ? corrections : movements.filter(row => row.sourceType === 'INVOICE_PAYMENT' && row.sourceId === payment.id && row.direction === 'IN');
        const links = {paymentId: payment.id, invoiceId: payment.invoiceId ?? null,
            agendaEventId: payment.agendaEventId ?? null, carePackageId: payment.carePackageId ?? null,
            paidAt: integrityDate(payment.paidAt)};
        const evidence = [payment, receipts];
        // CREDIT status means an actual receipt retained as patient credit. CREDIT source means non-cash coverage.
        if (NON_CASH.has(payment.source)) {
            if (receipts.length) add('UNEXPECTED_RECEIPT', payment, {...links, movementId: receipts[0].id,
                title: 'Copertura con un movimento monetario inatteso',
                description: 'La copertura da credito, pacchetto o saldo precedente risulta associata a un’entrata. Apri l’origine per verificare la registrazione.'}, evidence);
            continue;
        }
        if (!['POSTED', 'CREDIT', 'VOID'].includes(payment.status)) continue;
        if (receipts.length > 1) {
            add('DUPLICATE_RECEIPT', payment, {...links, title: 'Più entrate per lo stesso incasso',
                description: 'L’incasso ha più movimenti collegati. Occorre correggere la registrazione di origine.'}, evidence);
            continue;
        }
        const original = receipts[0];
        if (!original) {
            if (payment.status !== 'VOID') add('MISSING_RECEIPT', payment, {...links, repair: payment.structureId ? 'RECEIPT' : null, needsAccount: true,
                needsDate: !links.paidAt, title: 'Incasso senza movimento sul conto',
                description: links.paidAt ? 'La data è disponibile. Indica il conto effettivamente usato per completare la prima nota.'
                    : 'Indica il conto effettivamente usato e la data dell’incasso; il software completerà il collegamento.'}, evidence);
            else add('MISSING_REVERSAL', payment, {...links, title: 'Annullamento senza entrata originale',
                description: 'Manca l’entrata originale: non è possibile ricostruire automaticamente il movimento di annullamento.'}, evidence);
            continue;
        }
        if (money(original.amount) !== money(payment.amount)) {
            add('AMOUNT_MISMATCH', payment, {...links, movementId: original.id, title: 'Importi non allineati',
                description: 'L’importo dell’incasso differisce da quello della prima nota. Apri l’origine per correggere la registrazione.'}, evidence);
        }
        if (!links.paidAt || links.paidAt !== integrityDate(original.occurredAt)) {
            add('DATE_MISMATCH', payment, {...links, movementId: original.id, title: 'Date non allineate',
                description: links.paidAt ? 'La data dell’incasso differisce da quella della prima nota. Le date originali sono conservate.'
                    : 'La data effettiva dell’incasso non è disponibile. Il movimento di prima nota esistente è conservato e va confrontato con la registrazione di origine.'}, evidence);
        }
        if (payment.status === 'VOID') {
            const reversals = movements.filter(row => row.reversalOfId === original.id && row.status === 'POSTED'
                && row.direction === 'OUT' && row.accountId === original.accountId && money(row.amount) === money(original.amount));
            if (!reversals.length) add('MISSING_REVERSAL', payment, {...links, movementId: original.id,
                repair: money(original.amount) === money(payment.amount) && !!integrityDate(payment.voidedAt) && accounts.has(original.accountId) ? 'REVERSAL' : null,
                title: 'Annullamento senza controregistrazione',
                description: integrityDate(payment.voidedAt) ? 'Conto, importo e data dell’annullamento sono disponibili per ricostruire lo storno.'
                    : 'La data dell’annullamento non è disponibile: il software non attribuisce un’uscita alla data di oggi.'}, [payment, original, reversals]);
        }
    }
    for (const movement of movements) {
        if (!accounts.has(movement.accountId)) add('ORPHAN_ACCOUNT', movement, {movementId: movement.id,
            title: 'Conto del movimento non disponibile',
            description: 'Il movimento fa riferimento a un conto assente. Occorre recuperare il conto per ricostruirne il saldo.'}, [movement]);
    }
    for (const expense of expenses) {
        const linked = movements.some(row => row.expenseId === expense.id && row.sourceType === 'EXPENSE_PAYMENT');
        if ((expense.status === 'PAID' || expense.paidAt) && !linked) add('LEGACY_EXPENSE', expense, {expenseId: expense.id,
            title: 'Spesa pagata senza uscita collegata',
            description: 'Lo stato precedente è conservato. Apri la spesa per collegare il pagamento effettivo, senza registrarlo due volte.'}, [expense]);
    }
    for (const credit of credits.filter(row => row.sourceType === 'TREASURY_ADVANCE')) {
        const incoming = movements.find(row => row.id === credit.sourceId && row.sourceType === 'PATIENT_ADVANCE'
            && row.sourceId === credit.id && row.direction === 'IN' && money(row.amount) === money(credit.amount));
        if (!incoming) add('CREDIT_LINK_MISSING', credit, {title: 'Anticipo senza entrata verificabile',
            description: 'Il credito non ha un’entrata collegata con lo stesso importo. Non viene creata un’entrata sostitutiva.'}, [credit]);
    }
    const creditTypes: Record<string, [string, string]> = {REFUND: ['PATIENT_CREDIT_REFUND', 'OUT'],
        REVERSE_REFUND: ['PATIENT_REFUND_VOID', 'IN'], VOID_ADVANCE: ['PATIENT_ADVANCE_VOID', 'OUT']};
    for (const creditMovement of creditMovements) {
        const expected = creditTypes[creditMovement.type];
        if (!expected) continue;
        const linked = movements.find(row => row.id === creditMovement.treasuryMovementId && row.sourceType === expected[0]
            && row.direction === expected[1] && money(row.amount) === money(creditMovement.amount));
        if (!linked) add('CREDIT_LINK_MISSING', creditMovement, {title: 'Movimento del credito senza prima nota verificabile',
            description: 'Il rimborso o la correzione del credito non ha un movimento contabile corrispondente.'}, [creditMovement]);
    }
    const transferIds = [...new Set(movements.filter(row => ['TRANSFER_OUT', 'TRANSFER_IN'].includes(row.sourceType)).map(row => row.sourceId))];
    for (const transferId of transferIds) {
        const pair = movements.filter(row => row.sourceId === transferId && ['TRANSFER_OUT', 'TRANSFER_IN'].includes(row.sourceType));
        const out = pair.find(row => row.sourceType === 'TRANSFER_OUT'), incoming = pair.find(row => row.sourceType === 'TRANSFER_IN');
        if (pair.length !== 2 || !out || !incoming || out.direction !== 'OUT' || incoming.direction !== 'IN'
            || out.accountId === incoming.accountId || money(out.amount) !== money(incoming.amount) || out.status !== incoming.status) {
            add('TRANSFER_MISMATCH', pair[0], {movementId: pair[0].id, title: 'Trasferimento incompleto',
                description: 'Le due parti del trasferimento non corrispondono. Il software conserva i movimenti presenti.'}, pair);
        }
    }
    for (const document of purchaseDocuments) {
        if (['PAID', 'PARTIAL'].includes(document.status) && !movements.some(row => expenses.some(expense => expense.id === row.expenseId && expense.purchaseDocumentId === document.id))) {
            add('LEGACY_PURCHASE_DOCUMENT', {...document, amount: document.total}, {title: 'Documento fornitore senza pagamento collegato',
                description: 'Lo stato precedente del documento è conservato. Collega il pagamento effettivo a una spesa del documento.'}, [document]);
        }
    }
    const paymentsById = new Map(payments.map(payment => [payment.id, payment]));
    for (const operation of settlementOperations) {
        const result = operation.result ?? {};
        const allocations = Array.isArray(result.allocations) ? result.allocations : [];
        const referenced: Row[] = [];
        const seen = new Set<string>();
        let cash = 0, credit = 0, invalid = !Array.isArray(result.allocations);
        for (const allocation of allocations) {
            if (!Array.isArray(allocation?.paymentIds) || !allocation.paymentIds.length) {invalid = true; continue;}
            for (const paymentId of allocation.paymentIds) {
                const payment = paymentsById.get(paymentId);
                if (seen.has(paymentId) || !payment || !Number.isFinite(Number(payment.amount)) || Number(payment.amount) <= 0
                    || ['PACKAGE', 'OPENING_BALANCE'].includes(payment.source)) {
                    invalid = true; continue;
                }
                seen.add(paymentId); referenced.push(payment);
                // These immutable totals describe the original allocation. Subsequent voids or
                // retained patient credit change its status, never the amount originally paid.
                if (payment.source === 'CREDIT') credit = money(credit + Number(payment.amount));
                else cash = money(cash + Number(payment.amount));
            }
        }
        const expectedCash = Number(result.cashAmount), expectedCredit = Number(result.creditAmount);
        if (!Number.isFinite(expectedCash) || expectedCash < 0 || !Number.isFinite(expectedCredit) || expectedCredit < 0
            || cash !== money(expectedCash) || credit !== money(expectedCredit)) invalid = true;
        if (invalid) add('SETTLEMENT_ALLOCATION_MISMATCH', {...operation,
            amount: Number.isFinite(expectedCash + expectedCredit) ? expectedCash + expectedCredit : 0}, {
            settlementOperationId: operation.id, title: 'Attribuzioni del saldo non allineate',
            description: 'Il totale degli incassi e dei crediti attribuiti non corrisponde alla registrazione cumulativa. Verifica le registrazioni di origine.'
        }, [operation, referenced]);
    }
    const counts = Object.fromEntries([...new Set(issues.map(issue => issue.kind))].map(kind => [kind, issues.filter(issue => issue.kind === kind).length]));
    return {issues, counts, total: issues.length};
}

import type {TreasuryClassificationChoice} from './treasuryAutomation.policy.js';
import {treasuryError} from './treasuryValidation.service.js';

/** Partition one explicit cash classification across the actual receipts, never duplicate its shares. */
export function treasuryClassificationAllocator(choice: TreasuryClassificationChoice | undefined, total: number) {
    const totalCents = Math.round(total * 100);
    let remainingTotal = totalCents;
    const shares = choice?.allocations?.map(row => ({...row, cents: Math.round(row.amount * 100)}));
    if (shares && shares.reduce((sum, row) => sum + row.cents, 0) !== totalCents) {
        treasuryError('Le quote delle categorie devono corrispondere al nuovo incasso', 422);
    }
    return (amount: number): TreasuryClassificationChoice | undefined => {
        if (!shares) return choice;
        const requested = Math.round(amount * 100);
        if (requested <= 0 || requested > remainingTotal) treasuryError('Ripartizione categorie non valida', 422);
        const allocations = shares.map((row, index) => {
            const exact = row.cents * requested / remainingTotal;
            return {index, cents: Math.floor(exact), remainder: exact - Math.floor(exact)};
        });
        let extra = requested - allocations.reduce((sum, row) => sum + row.cents, 0);
        for (const row of [...allocations].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
            if (!extra) break;
            row.cents++; extra--;
        }
        remainingTotal -= requested;
        return {...choice, businessCategoryId: null, allocations: allocations.filter(row => row.cents > 0).map(row => {
            shares[row.index].cents -= row.cents;
            return {businessCategoryId: shares[row.index].businessCategoryId, amount: row.cents / 100};
        })};
    };
}

export function treasuryOperationSource(category: unknown, direction: 'IN' | 'OUT'): string {
    if (category === 'PATIENT_ADVANCE' && direction === 'IN') return 'PATIENT_ADVANCE';
    if (['REFUND', 'PATIENT_CREDIT_REFUND'].includes(String(category)) && direction === 'OUT') return 'PATIENT_REFUND';
    if (category === 'SUPPLIER_PAYMENT' && direction === 'OUT') return 'SUPPLIER_PAYMENT';
    if (['COLLECTION', 'INVOICE_PAYMENT'].includes(String(category)) && direction === 'IN') return 'INVOICE_PAYMENT';
    return direction === 'IN' ? 'MANUAL_IN' : 'MANUAL_OUT';
}

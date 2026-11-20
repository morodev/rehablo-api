import {TREASURY_UUID, treasuryError} from './treasuryValidation.service.js';

export interface TreasuryShare {businessCategoryId: string | null; amount: number;}
export interface TreasuryClassificationChoice {businessCategoryId?: string | null; allocations?: TreasuryShare[]; tagIds?: string[];}
export interface TreasuryWeight {businessCategoryId: string | null; weight: number;}
export type TreasurySourceKind = 'SERVICE' | 'PRODUCT' | 'EVENT_TYPE' | 'PACKAGE_TEMPLATE' | 'APPOINTMENT' | 'INVOICE' | 'PACKAGE' | 'EXPENSE' | 'OPERATION';
export interface TreasurySource {kind: TreasurySourceKind; id: string;}
export const AUTOMATION_OPERATIONS = ['PATIENT_ADVANCE', 'PATIENT_REFUND', 'MANUAL_IN', 'MANUAL_OUT', 'INVOICE_PAYMENT', 'SUPPLIER_PAYMENT'] as const;
export function classificationCategory(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== 'string' || !TREASURY_UUID.test(value)) treasuryError('Categoria non valida', 422);
    return (value as string).toLowerCase();
}
export function normalizeTreasuryClassificationChoice(value: unknown): TreasuryClassificationChoice | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) treasuryError('Classificazione non valida', 422);
    const raw = value as Record<string, unknown>;
    if (Object.keys(raw).some(key => !['businessCategoryId', 'allocations', 'tagIds'].includes(key))) treasuryError('Campo classificazione non valido', 422);
    const tagsOnly=raw.businessCategoryId===undefined&&raw.allocations===undefined&&raw.tagIds!==undefined;
    const result: TreasuryClassificationChoice = tagsOnly?{}:{businessCategoryId: classificationCategory(raw.businessCategoryId)};
    if (raw.allocations !== undefined) {
        if (!Array.isArray(raw.allocations) || !raw.allocations.length || raw.allocations.length > 100 || result.businessCategoryId) treasuryError('Ripartizione non valida', 422);
        result.allocations = (raw.allocations as unknown[]).map(value => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) treasuryError('Quota non valida', 422);
            const share = value as Record<string, unknown>;
            if (Object.keys(share).some(key => !['businessCategoryId', 'amount'].includes(key)) || typeof share.amount !== 'number' || !Number.isFinite(share.amount) || share.amount <= 0 || Math.abs(share.amount * 100 - Math.round(share.amount * 100)) > 1e-6) treasuryError('Importo della quota non valido', 422);
            return {businessCategoryId: classificationCategory(share.businessCategoryId), amount: share.amount as number};
        });
    }
    if (raw.tagIds !== undefined) {
        if (!Array.isArray(raw.tagIds) || raw.tagIds.length > 50) treasuryError('Tag non validi', 422);
        result.tagIds = [...new Set(raw.tagIds.map(value => classificationCategory(value)))].map(value => {if (!value) treasuryError('Tag non valido',422); return value!;}).sort();
    }
    return result;
}
export function normalizeTreasurySource(value: unknown): TreasurySource {
    if (!value || typeof value !== 'object') treasuryError('Origine non valida', 422);
    const {kind, id} = value as Record<string, unknown>;
    if (!['SERVICE','PRODUCT','EVENT_TYPE','PACKAGE_TEMPLATE','APPOINTMENT','INVOICE','PACKAGE','EXPENSE','OPERATION'].includes(String(kind))) treasuryError('Origine non valida', 422);
    if (kind === 'OPERATION') {
        if (!(AUTOMATION_OPERATIONS as readonly unknown[]).includes(id)) treasuryError('Operazione non valida', 422);
        return {kind, id: id as string};
    }
    if (typeof id !== 'string' || !TREASURY_UUID.test(id)) treasuryError('Origine non valida', 422);
    return {kind: kind as TreasurySourceKind, id: (id as string).toLowerCase()};
}
export function groupTreasuryShares(shares: TreasuryShare[]): TreasuryShare[] {
    const groups = new Map<string | null, number>();
    for (const share of shares) groups.set(share.businessCategoryId, (groups.get(share.businessCategoryId) ?? 0) + Math.round(share.amount * 100));
    return [...groups].filter(([,amount]) => amount > 0).sort(([a], [b]) => (a ?? '').localeCompare(b ?? '')).map(([businessCategoryId, amount]) => ({businessCategoryId, amount: amount / 100}));
}
/** Largest remainder allocation in integer cents; stable tie ordering and exact conservation. */
export function allocateTreasuryAmount(amount: number, weights: TreasuryWeight[]): TreasuryShare[] {
    const cents = Math.round(amount * 100);
    if (!Number.isSafeInteger(cents) || cents < 0) treasuryError('Importo non valido', 422);
    if (!cents) return [];
    const grouped = new Map<string | null, number>();
    for (const item of weights) if (Number.isFinite(item.weight) && item.weight > 0) grouped.set(item.businessCategoryId, (grouped.get(item.businessCategoryId) ?? 0) + item.weight);
    if (!grouped.size) return [{businessCategoryId: null, amount: cents / 100}];
    const total = [...grouped.values()].reduce((a,b) => a+b, 0);
    const parts = [...grouped].sort(([a],[b]) => (a ?? '').localeCompare(b ?? '')).map(([businessCategoryId, weight], index) => {
        const exact = cents * weight / total;
        return {businessCategoryId, cents: Math.floor(exact), remainder: exact - Math.floor(exact), index};
    });
    let residual = cents - parts.reduce((sum,item) => sum + item.cents, 0);
    const order = [...parts].sort((a,b) => b.remainder - a.remainder || a.index-b.index);
    for (let i=0; residual>0; i++,residual--) order[i % order.length].cents++;
    return parts.filter(item => item.cents > 0).map(item => ({businessCategoryId:item.businessCategoryId, amount:item.cents/100}));
}
export function choiceShares(amount: number, choice: TreasuryClassificationChoice): TreasuryShare[] {
    if(choice.businessCategoryId===undefined&&!choice.allocations)treasuryError('La categoria automatica richiede una origine',422);
    const shares = choice.allocations ?? [{businessCategoryId: choice.businessCategoryId??null, amount}];
    if (shares.reduce((sum, item) => sum + Math.round(item.amount * 100), 0) !== Math.round(amount * 100)) treasuryError('Le quote devono coincidere con l’importo del movimento', 422);
    return groupTreasuryShares(shares);
}

/** Allocate the next receipt against cumulative shares so installment rounding is carried forward. */
export function allocateTreasuryIncrement(amount:number,weights:TreasuryWeight[],previous:TreasuryShare[]):TreasuryShare[] {
    if(!previous.length)return allocateTreasuryAmount(amount,weights);
    const paid=groupTreasuryShares(previous),paidByCategory=new Map(paid.map(item=>[item.businessCategoryId,Math.round(item.amount*100)]));
    const total=(Math.round(amount*100)+paid.reduce((sum,item)=>sum+Math.round(item.amount*100),0))/100;
    const target=allocateTreasuryAmount(total,weights);
    const remaining=target.map(item=>({businessCategoryId:item.businessCategoryId,weight:Math.max(0,Math.round(item.amount*100)-(paidByCategory.get(item.businessCategoryId)??0))}));
    // Explicit earlier overrides may exceed a category's proportional share. Preserve them and allocate only the new cash.
    return allocateTreasuryAmount(amount,remaining);
}

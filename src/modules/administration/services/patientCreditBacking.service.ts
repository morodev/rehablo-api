import {Op, Transaction} from 'sequelize';
import {TreasuryMovement} from '../models/index.js';

type Plain = Record<string, any>;

function supportedCredit(credit: Plain): boolean {
    return !!credit.sourceId && ['TREASURY_ADVANCE', 'VOID_CREDIT'].includes(credit.sourceType);
}

function matchesReceipt(credit: Plain, receipt: Plain): boolean {
    return receipt.status === 'POSTED' && receipt.direction === 'IN' && receipt.structureId === credit.structureId
        && Number(receipt.amount) >= Number(credit.amount)
        && (credit.sourceType !== 'TREASURY_ADVANCE'
            || (receipt.sourceType === 'PATIENT_ADVANCE' && receipt.sourceId === credit.id));
}

/** A source label alone is not evidence that money was received and is still backed. */
export async function verifiedSettlementCredit(schema: string, credit: Plain, transaction?: Transaction): Promise<boolean> {
    if (!supportedCredit(credit)) return false;
    const model = credit.sourceType === 'TREASURY_ADVANCE'
        ? await TreasuryMovement.schema(schema).findByPk(credit.sourceId, {transaction})
        : await TreasuryMovement.schema(schema).findOne({where: {sourceType: {[Op.in]: ['INVOICE_PAYMENT', 'INVOICE_PAYMENT_CORRECTION']}, sourceId: credit.sourceId},
            order: [['sourceType', 'DESC']], transaction});
    if (!model) return false;
    const receipt = model.get({plain: true});
    if (!matchesReceipt(credit, receipt)) return false;
    return await TreasuryMovement.schema(schema).count({where: {reversalOfId: receipt.id, status: 'POSTED'}, transaction}) === 0;
}

/** Same backing rule, with two ledger reads for the whole patient instead of reads per credit. */
export async function verifiedPatientCredits(schema: string, credits: Plain[], transaction?: Transaction): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>(credits.map(credit => [String(credit.id), false]));
    const candidates = credits.filter(supportedCredit);
    if (!candidates.length) return result;
    const advanceIds = candidates.filter(credit => credit.sourceType === 'TREASURY_ADVANCE').map(credit => credit.sourceId);
    const paymentIds = candidates.filter(credit => credit.sourceType === 'VOID_CREDIT').map(credit => credit.sourceId);
    const clauses = [
        ...(advanceIds.length ? [{id: {[Op.in]: advanceIds}}] : []),
        ...(paymentIds.length ? [{sourceType: {[Op.in]: ['INVOICE_PAYMENT', 'INVOICE_PAYMENT_CORRECTION']}, sourceId: {[Op.in]: paymentIds}}] : [])
    ];
    const receipts = (await TreasuryMovement.schema(schema).findAll({where: {[Op.or]: clauses}, transaction}))
        .map(model => model.get({plain: true}) as Plain);
    const ids = receipts.map(receipt => receipt.id);
    const reversals = ids.length ? await TreasuryMovement.schema(schema).findAll({
        where: {reversalOfId: {[Op.in]: ids}, status: 'POSTED'}, attributes: ['reversalOfId'], transaction
    }) : [];
    const reversed = new Set(reversals.map(model => String(model.get('reversalOfId'))));
    for (const credit of candidates) {
        const receipt = credit.sourceType === 'TREASURY_ADVANCE' ? receipts.find(row => row.id === credit.sourceId)
            : receipts.find(row => row.sourceType === 'INVOICE_PAYMENT_CORRECTION' && row.sourceId === credit.sourceId)
                ?? receipts.find(row => row.sourceType === 'INVOICE_PAYMENT' && row.sourceId === credit.sourceId);
        result.set(String(credit.id), !!receipt && matchesReceipt(credit, receipt) && !reversed.has(String(receipt.id)));
    }
    return result;
}

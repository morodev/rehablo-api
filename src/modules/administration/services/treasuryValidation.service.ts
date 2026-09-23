import { Request } from 'express';
import { Transaction } from 'sequelize';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { Structure } from '../../auth/models/index.js';
import { FinancialAccount, PaymentMethod } from '../models/index.js';

export const TREASURY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function treasuryError(message: string, statusCode = 400): never {
    throw Object.assign(new Error(message), { statusCode });
}

export function nullableTreasuryUuid(value: unknown, label: string): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !TREASURY_UUID.test(value)) treasuryError(label + ' non valido');
    return value;
}

export async function validateTreasuryAccount(schema: string, accountId: unknown, structureId: unknown, transaction?: Transaction) {
    if (typeof accountId !== 'string' || !TREASURY_UUID.test(accountId)) treasuryError('Seleziona un conto valido');
    if (typeof structureId !== 'string' || !TREASURY_UUID.test(structureId)) treasuryError('Seleziona una sede valida');
    const account = await FinancialAccount.schema(schema).findOne({ where: { id: accountId, isActive: true }, transaction });
    if (!account) treasuryError('Il conto selezionato non è disponibile o non è attivo');
    if (account.get('structureId') && account.get('structureId') !== structureId) {
        treasuryError('Il conto selezionato appartiene a un’altra sede');
    }
    return account;
}

export async function validateTreasuryMethod(schema: string, value: unknown, transaction?: Transaction) {
    const id = nullableTreasuryUuid(value, 'Metodo di pagamento');
    if (!id) return null;
    const method = await PaymentMethod.schema(schema).findOne({ where: { id, isActive: true }, transaction });
    if (!method) treasuryError('Il metodo di pagamento selezionato non è disponibile o non è attivo');
    return method;
}

export async function validateManualTreasuryMovement(req: Request, payload: Record<string, unknown>): Promise<void> {
    for (const field of ['paymentMethodId', 'invoiceId', 'expenseId', 'sourceId', 'reversalOfId']) {
        payload[field] = nullableTreasuryUuid(payload[field], 'Collegamento del movimento');
    }
    if (payload.invoiceId || payload.sourceId || payload.reversalOfId || payload.sourceType) {
        treasuryError('Per registrare un incasso collegato a una fattura, usa Registra incasso dalla fattura');
    }
    const amount = Number(payload.amount);
    if (!Number.isFinite(amount) || Math.round(amount * 100) < 1) treasuryError('L’importo deve essere maggiore di zero');
    if (!['IN', 'OUT'].includes(String(payload.direction))) treasuryError('Seleziona entrata o uscita');
    const occurredAt = typeof payload.occurredAt === 'string' ? new Date(payload.occurredAt) : new Date(NaN);
    const calendarDate = String(payload.occurredAt ?? '').slice(0, 10);
    const parsedDay = new Date(calendarDate + 'T12:00:00.000Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(calendarDate) || Number.isNaN(occurredAt.getTime())
        || Number.isNaN(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== calendarDate) {
        treasuryError('Indica una data valida per il movimento');
    }
    await validateTreasuryAccount(req.tenantSchema!, payload.accountId, payload.structureId);
    const structure = await Structure.findOne({ where: { id: payload.structureId as string, tenantId: getCurrentTenantId(req) } });
    if (!structure) treasuryError('La sede selezionata non è disponibile');
    await validateTreasuryMethod(req.tenantSchema!, payload.paymentMethodId);
    payload.amount = Math.round(amount * 100) / 100;
    payload.category = String(payload.category ?? '').trim() || 'OTHER';
}

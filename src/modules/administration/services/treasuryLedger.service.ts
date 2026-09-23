import { createHash } from 'node:crypto';
import { Request } from 'express';
import { Model, Op } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { Structure } from '../../auth/models/index.js';
import { DailyClosing, FinancialAccount, TreasuryMovement } from '../models/index.js';
import { resolveAdministrationDateRange, resolveAdministrationStructure, romeToday } from './administrationQuery.service.js';
import { TREASURY_UUID, treasuryError } from './treasuryValidation.service.js';

type MovementRow = Record<string, any>;

/**
 * A recorded reversal compensates its original entry on the reversal date.
 * Legacy VOID entries without a corresponding posted reversal remain excluded.
 * Load the complete account/structure ledger before applying a date/status filter.
 */
export function balanceEffectiveMovements<T extends MovementRow>(rows: readonly T[]): T[] {
    const originals = new Map(rows.map(row => [String(row.id), row]));
    const reversed = new Set<string>();
    for (const row of rows) {
        if (row.status !== 'POSTED' || !row.reversalOfId) continue;
        const original = originals.get(String(row.reversalOfId));
        if (original && original.accountId === row.accountId
            && ['IN', 'OUT'].includes(original.direction) && ['IN', 'OUT'].includes(row.direction)
            && original.direction !== row.direction && Number(original.amount) > 0
            && Math.round(Number(original.amount) * 100) === Math.round(Number(row.amount) * 100)) {
            reversed.add(String(original.id));
        }
    }
    return rows.filter(row => row.status === 'POSTED' || (row.status === 'VOID' && reversed.has(String(row.id))));
}

export function treasuryBalance(rows: readonly MovementRow[], initialBalance: number = 0): number {
    return rows.reduce((cents, row) => cents + Math.round(Number(row.amount) * 100) * (row.direction === 'IN' ? 1 : -1),
        Math.round(Number(initialBalance) * 100)) / 100;
}

export function closingBalances(rows: readonly MovementRow[], initialBalance: number, closedOn: string) {
    const period = resolveAdministrationDateRange(closedOn, closedOn);
    const effective = balanceEffectiveMovements(rows);
    return {
        openingBalance: treasuryBalance(effective.filter(row => new Date(row.occurredAt).getTime() < period.fromInstant!.getTime()), initialBalance),
        expectedBalance: treasuryBalance(effective.filter(row => new Date(row.occurredAt).getTime() <= period.toInstant!.getTime()), initialBalance)
    };
}

/** Optimistic preview check. It does not lock a day against later ledger entries. */
export function closingPreviewVersion(accountId: string, initialBalance: number, rows: readonly MovementRow[], closedOn: string): string {
    const end = resolveAdministrationDateRange(closedOn, closedOn).toInstant!.getTime();
    const effective = balanceEffectiveMovements(rows).filter(row => new Date(row.occurredAt).getTime() <= end)
        .map(row => [String(row.id), row.direction, Math.round(Number(row.amount) * 100),
            new Date(row.occurredAt).toISOString(), row.status, row.reversalOfId ?? null])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
    return createHash('sha256').update(JSON.stringify([accountId, closedOn, Math.round(initialBalance * 100), effective])).digest('hex');
}
function visibleStructureWhere(req: Request): Record<string | symbol, unknown> {
    const scope = resolveAdministrationStructure(req.access, null);
    return scope.kind === 'all' ? {} : { structureId: scope.kind === 'structure' ? scope.structureId : { [Op.in]: [] } };
}

function requiredUuid(value: unknown, message: string): string {
    if (typeof value !== 'string' || !TREASURY_UUID.test(value)) treasuryError(message);
    return value;
}

export async function createTreasuryClosing(req: Request, source: Record<string, unknown>): Promise<Model> {
    const accountId = requiredUuid(source.accountId, 'Seleziona un conto cassa valido');
    const closedOn = typeof source.closedOn === 'string' ? source.closedOn : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(closedOn)) treasuryError('Indica una data valida per la chiusura');
    try { resolveAdministrationDateRange(closedOn, closedOn); }
    catch { treasuryError('Indica una data valida per la chiusura'); }
    if (closedOn > romeToday()) treasuryError('La data di chiusura non può essere futura');
    if (!['number', 'string'].includes(typeof source.countedBalance) || source.countedBalance === null || source.countedBalance === undefined || source.countedBalance === ''
        || (typeof source.countedBalance === 'string' && !/^\d+(\.\d{1,2})?$/.test(source.countedBalance))
        || !Number.isFinite(Number(source.countedBalance)) || Number(source.countedBalance) < 0 || Number(source.countedBalance) > 9999999999.99) {
        treasuryError('Il saldo contato deve essere un importo maggiore o uguale a zero');
    }
    const countedBalance = Math.round(Number(source.countedBalance) * 100) / 100;
    if (source.notes != null && typeof source.notes !== 'string') treasuryError('Inserisci una nota valida');
    return sequelize.transaction(async transaction => {
        const Account = FinancialAccount.schema(req.tenantSchema!);
        const where = visibleStructureWhere(req);
        if (req.access?.scope === 'structure' && req.access.structureId) {
            delete where.structureId;
            where[Op.or] = [{ structureId: req.access.structureId }, { structureId: null }];
        }
        const account = await Account.findOne({ where: { id: accountId, ...where }, transaction, lock: transaction.LOCK.UPDATE });
        if (!account || !account.get('isActive')) treasuryError('Il conto cassa selezionato non è disponibile o non è attivo', 404);
        if (account.get('type') !== 'CASH') treasuryError('La chiusura è disponibile solo per i conti cassa');
        if (!account.get('structureId') && req.access?.scope !== 'tenant') {
            treasuryError('La chiusura di una cassa condivisa richiede accesso a tutte le sedi', 403);
        }
        if (req.access?.scope !== 'tenant'
            && (req.access?.scope !== 'structure' || account.get('structureId') !== req.access.structureId)) {
            treasuryError('Non hai accesso alla sede di questo conto cassa', 403);
        }
        const structureId = account.get('structureId') || req.access?.structureId;
        if (!structureId) treasuryError('Seleziona una sede operativa prima di chiudere la cassa');
        const structure = await Structure.findOne({ where: { id: structureId, tenantId: getCurrentTenantId(req) }, transaction });
        if (!structure) treasuryError('La sede del conto cassa non è disponibile');
        const Closing = DailyClosing.schema(req.tenantSchema!);
        if (await Closing.findOne({ where: { accountId, closedOn }, transaction })) {
            treasuryError('La chiusura di questa cassa è già stata registrata per la data selezionata', 409);
        }
        const movementModels = await TreasuryMovement.schema(req.tenantSchema!).findAll({ where: { accountId }, transaction });
        const movements = movementModels.map(row => row.get({ plain: true }));
        if (source.previewVersion !== undefined && (typeof source.previewVersion !== 'string'
            || source.previewVersion !== closingPreviewVersion(accountId, Number(account.get('openingBalance')), movements, closedOn))) {
            treasuryError('I movimenti o il saldo iniziale sono cambiati. Ricarica il riepilogo prima di registrare la chiusura.', 409);
        }
        const balances = closingBalances(movements, Number(account.get('openingBalance')), closedOn);
        return Closing.create({
            accountId, structureId, closedOn, ...balances, countedBalance,
            difference: Math.round((countedBalance - balances.expectedBalance) * 100) / 100,
            notes: String(source.notes ?? '').trim() || null, status: 'CLOSED', closedByUserId: req.access?.userId ?? null
        }, { transaction });
    });
}

export async function reverseTreasuryMovement(req: Request, source: Record<string, unknown>): Promise<{ row: Model; created: boolean }> {
    const id = requiredUuid(req.params.id, 'Movimento non valido');
    const key = req.header('Idempotency-Key')?.trim();
    if (!key) treasuryError('Identificativo dello storno mancante');
    if (key.length > 255) treasuryError('Identificativo dello storno non valido');
    const reason = typeof source.reason === 'string' ? source.reason.trim() : '';
    if (!reason) treasuryError('Indica il motivo dello storno');
    return sequelize.transaction(async transaction => {
        await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))', {
            transaction, replacements: { lockKey: req.tenantSchema + ':treasury-reversal:' + key }
        });
        const Movement = TreasuryMovement.schema(req.tenantSchema!);
        const original = await Movement.findOne({ where: { id, ...visibleStructureWhere(req) }, transaction, lock: transaction.LOCK.UPDATE });
        if (!original) treasuryError('Movimento registrato non trovato', 404);
        const prior = await Movement.findOne({ where: { idempotencyKey: key }, transaction });
        if (prior) {
            if (prior.get('reversalOfId') !== id || prior.get('voidReason') !== reason) {
                treasuryError('Questa richiesta di storno è già stata utilizzata per un altro movimento o motivo', 409);
            }
            return { row: prior, created: false };
        }
        if (original.get('invoiceId') || original.get('expenseId') || original.get('sourceId')
            || (original.get('sourceType') && original.get('sourceType') !== 'MANUAL')
            || original.get('reversalOfId')) {
            treasuryError('Gestisci lo storno dal documento o dalla seduta di origine del movimento', 409);
        }
        if (original.get('status') !== 'POSTED'
            || await Movement.findOne({ where: { reversalOfId: id, status: 'POSTED' }, transaction })) {
            treasuryError('Questo movimento è già stato stornato', 409);
        }
        const row = await Movement.create({
            accountId: original.get('accountId'), structureId: original.get('structureId'),
            direction: original.get('direction') === 'IN' ? 'OUT' : 'IN', category: 'REVERSAL',
            amount: original.get('amount'), occurredAt: new Date(), status: 'POSTED',
            paymentMethodId: original.get('paymentMethodId'), counterparty: original.get('counterparty'),
            description: 'Storno: ' + (String(original.get('description') ?? '').trim() || 'Movimento manuale'),
            idempotencyKey: key, createdByUserId: req.access?.userId, reversalOfId: id, voidReason: reason
        }, { transaction });
        await original.update({ status: 'VOID', voidReason: reason }, { transaction });
        return { row, created: true };
    });
}

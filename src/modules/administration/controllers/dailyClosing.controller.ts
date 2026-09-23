import { Request } from 'express';
import { Model, Op } from 'sequelize';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { Structure, TenantUser, User } from '../../auth/models/index.js';
import { DailyClosing, FinancialAccount, PaymentMethod, TreasuryMovement } from '../models/index.js';
import { AdministrationQueryError, parseAdministrationUuid, resolveAdministrationDateRange, resolveAdministrationStructure, romeToday } from '../services/administrationQuery.service.js';
import { balanceEffectiveMovements, closingBalances, closingPreviewVersion } from '../services/treasuryLedger.service.js';
import { treasuryError } from '../services/treasuryValidation.service.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendSuccessResponse } from '../../../utils/response.js';

type Row = Record<string, any>;
const plain = (row: Model): Row => row.get({ plain: true });
const cents = (value: unknown): number => Math.round(Number(value) * 100);

function text(value: unknown, label: string): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || value.length > 100) throw new AdministrationQueryError(label + ' non valido');
    return value.trim() || undefined;
}
function pageNumber(value: unknown, fallback: number, minimum: number): number {
    if (value === undefined || value === '') return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) {
        throw new AdministrationQueryError('Pagina non valida');
    }
    return Number(value);
}
function filters(req: Request) {
    const accountId = parseAdministrationUuid(text(req.query.accountId, 'Conto'), 'Conto');
    const selection = resolveAdministrationStructure(req.access, text(req.query.structureId, 'Sede'));
    const period = resolveAdministrationDateRange(text(req.query.from, 'Data iniziale'), text(req.query.to, 'Data finale'));
    const differenceState = text(req.query.differenceState, 'Esito');
    if (differenceState && !['balanced', 'difference', 'changed'].includes(differenceState)) throw new AdministrationQueryError('Esito non valido');
    return { accountId, selection, period, differenceState,
        limit: Math.min(pageNumber(req.query.limit, 25, 1), 200), offset: pageNumber(req.query.offset, 0, 0) };
}

async function accessibleAccounts(req: Request, accountId?: string | null): Promise<Map<string, Row>> {
    const selection = resolveAdministrationStructure(req.access, text(req.query.structureId, 'Sede'));
    if (selection.kind === 'none') return new Map();
    if (selection.kind === 'structure' && req.access?.scope === 'tenant') {
        const exists = await Structure.count({ where: { id: selection.structureId, tenantId: getCurrentTenantId(req) } });
        if (!exists) throw new AdministrationQueryError('Sede non valida');
    }
    const where: Record<PropertyKey, unknown> = accountId ? { id: accountId } : {};
    if (selection.kind === 'structure') {
        // A shared cash account includes other premises: only tenant-wide permission may expose it.
        if (req.access?.scope === 'tenant') where[Op.or] = [{ structureId: selection.structureId }, { structureId: null }];
        else where.structureId = selection.structureId;
    }
    const accounts = await FinancialAccount.schema(req.tenantSchema!).findAll({ where });
    return new Map(accounts.map(model => { const row = plain(model); return [String(row.id), row]; }));
}
async function ledger(req: Request, accountIds: string[]): Promise<Row[]> {
    if (!accountIds.length) return [];
    return (await TreasuryMovement.schema(req.tenantSchema!).findAll({ where: { accountId: { [Op.in]: accountIds } } })).map(plain);
}

/** Compare today's ledger with the stored snapshot; never rewrite a previous closing. */
export function closingState(closing: Row, account: Row, movements: Row[]) {
    const balances = closingBalances(movements, Number(account.openingBalance), closing.closedOn);
    const boundary = resolveAdministrationDateRange(closing.closedOn, closing.closedOn).toInstant!.getTime();
    const registeredAt = new Date(closing.createdAt).getTime();
    const changedMovement = movements.some(row => new Date(row.occurredAt).getTime() <= boundary
        && [row.createdAt, row.updatedAt].some(value => new Date(value).getTime() > registeredAt));
    return {
        currentExpectedBalance: balances.expectedBalance,
        hasSubsequentChanges: cents(balances.expectedBalance) !== cents(closing.expectedBalance)
            || cents(balances.openingBalance) !== cents(closing.openingBalance) || changedMovement
    };
}
async function enrich(req: Request, closings: Row[], accounts: Map<string, Row>, movements: Row[]): Promise<Row[]> {
    const tenantId = getCurrentTenantId(req);
    const structureIds = [...new Set(closings.map(row => row.structureId).filter(Boolean))];
    const operatorIds = [...new Set(closings.map(row => row.closedByUserId).filter(Boolean))];
    const [structures, members] = await Promise.all([
        structureIds.length ? Structure.findAll({ where: { id: { [Op.in]: structureIds }, tenantId }, attributes: ['id', 'name'] }) : [],
        operatorIds.length ? TenantUser.findAll({ where: { userId: { [Op.in]: operatorIds }, tenantId }, attributes: ['userId'] }) : []
    ]);
    const memberIds = members.map(row => row.get('userId'));
    const users = memberIds.length ? await User.findAll({ where: { id: { [Op.in]: memberIds } }, attributes: ['id', 'name', 'surname'] }) : [];
    const structureNames = new Map(structures.map(row => [String(row.get('id')), row.get('name')] as const));
    const operatorNames = new Map(users.map(row => [String(row.get('id')), [row.get('name'), row.get('surname')].filter(Boolean).join(' ') || null]));
    const byAccount = new Map<string, Row[]>();
    movements.forEach(row => { const key = String(row.accountId); const group = byAccount.get(key) ?? []; group.push(row); byAccount.set(key, group); });
    return closings.map(row => ({
        ...row, openingBalance: Number(row.openingBalance), expectedBalance: Number(row.expectedBalance),
        countedBalance: Number(row.countedBalance), difference: Number(row.difference),
        accountName: accounts.get(String(row.accountId))!.name,
        structureName: structureNames.get(String(row.structureId)) ?? null,
        operatorName: operatorNames.get(String(row.closedByUserId)) ?? null,
        ...closingState(row, accounts.get(String(row.accountId))!, byAccount.get(String(row.accountId)) ?? [])
    }));
}
function closingWhere(req: Request, accounts: Map<string, Row>): Record<PropertyKey, unknown> {
    const selection = resolveAdministrationStructure(req.access, text(req.query.structureId, 'Sede'));
    return { accountId: { [Op.in]: [...accounts.keys()] }, ...(selection.kind === 'structure' ? { structureId: selection.structureId } : {}) };
}

export const listDailyClosings = asyncHandler(async (req, res) => {
    const query = filters(req);
    const accounts = await accessibleAccounts(req, query.accountId);
    const where = closingWhere(req, accounts);
    if (query.period.from || query.period.to) where.closedOn = {
        ...(query.period.from ? { [Op.gte]: query.period.from } : {}), ...(query.period.to ? { [Op.lte]: query.period.to } : {})
    };
    const closings = accounts.size ? (await DailyClosing.schema(req.tenantSchema!).findAll({ where, order: [['closedOn', 'DESC'], ['createdAt', 'DESC'], ['id', 'DESC']] })).map(plain) : [];
    const rows = await enrich(req, closings, accounts, await ledger(req, [...new Set(closings.map(row => String(row.accountId)))]));
    const filtered = rows.filter(row => !query.differenceState
        || (query.differenceState === 'changed' ? row.hasSubsequentChanges
            : !row.hasSubsequentChanges && (query.differenceState === 'balanced' ? cents(row.difference) === 0 : cents(row.difference) !== 0)));
    return sendSuccessResponse(res, 200, { items: filtered.slice(query.offset, query.offset + query.limit), total: filtered.length,
        limit: query.limit, offset: query.offset });
});

export const getDailyClosing = asyncHandler(async (req, res) => {
    const id = parseAdministrationUuid(req.params.id, 'Chiusura');
    if (!id) throw new AdministrationQueryError('Chiusura non valida');
    const accounts = await accessibleAccounts(req);
    const closing = accounts.size ? await DailyClosing.schema(req.tenantSchema!).findOne({ where: { id, ...closingWhere(req, accounts) } }) : null;
    if (!closing) treasuryError('Chiusura cassa non disponibile', 404);
    const row = plain(closing);
    const [result] = await enrich(req, [row], accounts, await ledger(req, [String(row.accountId)]));
    return sendSuccessResponse(res, 200, result);
});

export const previewDailyClosing = asyncHandler(async (req, res) => {
    const accountId = parseAdministrationUuid(text(req.query.accountId, 'Conto'), 'Conto');
    if (!accountId) throw new AdministrationQueryError('Seleziona un conto cassa');
    const closedOn = text(req.query.closedOn, 'Data di chiusura');
    if (!closedOn) throw new AdministrationQueryError('Seleziona la data della chiusura');
    let period;
    try { period = resolveAdministrationDateRange(closedOn, closedOn); }
    catch { throw new AdministrationQueryError('Indica una data valida per la chiusura'); }
    if (closedOn > romeToday()) throw new AdministrationQueryError('La data di chiusura non può essere futura');
    const account = (await accessibleAccounts(req, accountId)).get(accountId);
    if (!account || !account.isActive) treasuryError('Il conto cassa selezionato non è disponibile o non è attivo', 404);
    if (account.type !== 'CASH') treasuryError('La chiusura è disponibile solo per i conti cassa');
    const structureId = account.structureId || req.access?.structureId;
    if (!structureId) treasuryError('Seleziona una sede operativa prima di chiudere la cassa');
    if (!await Structure.count({ where: { id: structureId, tenantId: getCurrentTenantId(req) } })) {
        treasuryError('La sede del conto cassa non è disponibile');
    }
    const [movements, existing] = await Promise.all([
        ledger(req, [accountId]), DailyClosing.schema(req.tenantSchema!).findOne({ where: { accountId, closedOn } })
    ]);
    const day = balanceEffectiveMovements(movements).filter(row => {
        const instant = new Date(row.occurredAt).getTime();
        return instant >= period.fromInstant!.getTime() && instant <= period.toInstant!.getTime();
    });
    const income = day.filter(row => row.direction === 'IN').reduce((sum, row) => sum + cents(row.amount), 0) / 100;
    const outcome = day.filter(row => row.direction === 'OUT').reduce((sum, row) => sum + cents(row.amount), 0) / 100;
    const methodIds = [...new Set(day.map(row => row.paymentMethodId).filter(Boolean))];
    const methods = methodIds.length ? await PaymentMethod.schema(req.tenantSchema!).findAll({
        where: { id: { [Op.in]: methodIds } }, attributes: ['id', 'type', 'code']
    }) : [];
    const nonCashTypes = new Set(['BANK', 'BANK_TRANSFER', 'TRANSFER', 'CARD', 'POS', 'CHEQUE', 'CHECK', 'DIRECT_DEBIT', 'DIGITAL']);
    const warnings = methods.some(row => nonCashTypes.has(String(row.get('type')).toUpperCase()) || nonCashTypes.has(String(row.get('code')).toUpperCase()))
        ? ['In questa cassa sono registrati movimenti con un metodo di pagamento diverso dai contanti. Controlla che siano stati associati al conto corretto.'] : [];
    return sendSuccessResponse(res, 200, { accountId, accountName: account.name, closedOn,
        previewVersion: closingPreviewVersion(accountId, Number(account.openingBalance), movements, closedOn), warnings,
        ...closingBalances(movements, Number(account.openingBalance), closedOn), income, outcome,
        movementCount: day.length, existingClosingId: existing ? String(existing.get('id')) : null });
});
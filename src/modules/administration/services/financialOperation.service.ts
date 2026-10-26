import {createHash} from 'node:crypto';
import {Request} from 'express';
import {Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {getUserId} from '../../../middleware/rbac.js';
import {FinancialOperation} from '../models/financialOperation.model.js';
import {treasuryError} from './treasuryValidation.service.js';

function stable(value: any): any {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value;
}
export function financialOperationKey(req: Request): string {
    const key = String(req.header?.('Idempotency-Key') ?? '').trim();
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(key)) treasuryError('Identificativo della registrazione obbligatorio e non valido');
    return key;
}
/** Validate source permissions before replay. Persist only after the entire writer succeeds. */
export async function beginFinancialOperation(req: Request, kind: string, structureId: string, transaction: Transaction,
    payload: unknown = {params: req.params, body: req.body}) {
    const idempotencyKey = financialOperationKey(req);
    const requestHash = createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex');
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))', {
        transaction, replacements: {lockKey: `${req.tenantSchema}:financial-operation:${idempotencyKey}`}});
    const previous = await FinancialOperation.schema(req.tenantSchema!).findOne({where: {idempotencyKey}, transaction});
    if (previous && (previous.get('kind') !== kind || previous.get('requestHash') !== requestHash
        || previous.get('createdByUserId') !== getUserId(req) || previous.get('structureId') !== structureId))
        treasuryError('Questa registrazione è già stata usata con dati diversi', 409);
    return {replay: previous ? previous.get('result') as Record<string, any> : null,
        complete: async (result: unknown) => FinancialOperation.schema(req.tenantSchema!).create({idempotencyKey, kind,
            requestHash, structureId, createdByUserId: getUserId(req), result: JSON.parse(JSON.stringify(result))}, {transaction})};
}

import { Op, Transaction, WhereOptions } from 'sequelize';
import Structure from '../../auth/models/structure.model.js';

export type AvailabilityMode = 'ALL' | 'SELECTED';

type MappingModel = {
    schema: (schema: string) => {
        findAll: (options: any) => Promise<any[]>;
        destroy: (options: any) => Promise<number>;
        bulkCreate: (rows: any[], options?: any) => Promise<any[]>;
    };
};

export function availabilityError(message: string, statusCode = 400): Error & {statusCode: number} {
    return Object.assign(new Error(message), {statusCode});
}

export function normalizeAvailabilityMode(value: unknown, fallback: AvailabilityMode = 'ALL'): AvailabilityMode {
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).toUpperCase();
    if (normalized !== 'ALL' && normalized !== 'SELECTED') {
        throw availabilityError('Modalita di disponibilita non valida');
    }
    return normalized;
}

export function normalizeStructureIds(value: unknown, fallback: string[] = []): string[] {
    if (value === undefined) return [...fallback];
    if (!Array.isArray(value)) throw availabilityError('L\'elenco delle sedi non e valido');
    return [...new Set(value.map(item => String(item ?? '').trim()).filter(Boolean))];
}

export async function tenantStructureIds(tenantId: string, transaction?: Transaction): Promise<string[]> {
    const rows = await Structure.findAll({where: {tenantId}, attributes: ['id'], transaction});
    return rows.map(row => row.get('id') as string);
}

export async function validateAvailability(
    tenantId: string,
    mode: AvailabilityMode,
    structureIds: string[],
    transaction?: Transaction
): Promise<string[]> {
    if (mode === 'SELECTED' && structureIds.length === 0) {
        throw availabilityError('Seleziona almeno una sede');
    }
    if (structureIds.length === 0) return [];
    const allowed = new Set(await tenantStructureIds(tenantId, transaction));
    if (structureIds.some(id => !allowed.has(id))) {
        throw availabilityError('Una o piu sedi non appartengono al centro');
    }
    return structureIds;
}

export async function mappedStructureIds(
    model: MappingModel,
    schema: string,
    foreignKey: string,
    itemId: string,
    transaction?: Transaction
): Promise<string[]> {
    const rows = await model.schema(schema).findAll({
        where: {[foreignKey]: itemId}, attributes: ['structureId'], transaction, raw: true
    });
    return rows.map(row => String(row.structureId));
}

export async function syncMappedStructures(
    model: MappingModel,
    schema: string,
    foreignKey: string,
    itemId: string,
    mode: AvailabilityMode,
    structureIds: string[],
    transaction: Transaction
): Promise<void> {
    const scoped = model.schema(schema);
    await scoped.destroy({where: {[foreignKey]: itemId}, transaction});
    if (mode === 'SELECTED' && structureIds.length > 0) {
        await scoped.bulkCreate(
            structureIds.map(structureId => ({[foreignKey]: itemId, structureId})),
            {transaction}
        );
    }
}

export async function availabilityWhere(
    model: MappingModel,
    schema: string,
    foreignKey: string,
    structureId?: string | null
): Promise<WhereOptions> {
    if (!structureId) return {availabilityMode: 'ALL'};
    const rows = await model.schema(schema).findAll({
        where: {structureId}, attributes: [foreignKey], raw: true
    });
    const ids = rows.map(row => String(row[foreignKey]));
    return {
        [Op.or]: [
            {availabilityMode: 'ALL'},
            ...(ids.length ? [{id: {[Op.in]: ids}}] : [])
        ]
    };
}

export async function decorateAvailability(
    rows: any[],
    model: MappingModel,
    schema: string,
    foreignKey: string,
    currentStructureId?: string | null
): Promise<any[]> {
    const plainRows = rows.map(row => typeof row?.get === 'function' ? row.get({plain: true}) : row);
    const ids = plainRows.map(row => row.id).filter(Boolean);
    const mappings = ids.length
        ? await model.schema(schema).findAll({
            where: {[foreignKey]: {[Op.in]: ids}}, attributes: [foreignKey, 'structureId'], raw: true
        })
        : [];
    const byItem = new Map<string, string[]>();
    for (const mapping of mappings) {
        const itemId = String(mapping[foreignKey]);
        byItem.set(itemId, [...(byItem.get(itemId) ?? []), String(mapping.structureId)]);
    }
    return plainRows.map(row => {
        const structureIds = byItem.get(String(row.id)) ?? [];
        return {
            ...row,
            structureIds,
            availableInCurrentStructure: row.availabilityMode === 'ALL'
                || (!!currentStructureId && structureIds.includes(currentStructureId))
        };
    });
}

export async function itemAvailableInStructure(
    item: any,
    model: MappingModel,
    schema: string,
    foreignKey: string,
    structureId?: string | null,
    transaction?: Transaction
): Promise<boolean> {
    if (!item) return false;
    const value = (key: string) => typeof item.get === 'function' ? item.get(key) : item[key];
    // I record creati prima della migrazione non avevano il campo: il default compatibile e ALL.
    if ((value('availabilityMode') ?? 'ALL') === 'ALL') return true;
    if (!structureId) return false;
    return (await model.schema(schema).findAll({
        where: {[foreignKey]: value('id'), structureId}, attributes: [foreignKey], transaction, raw: true,
        limit: 1
    })).length > 0;
}

export async function effectiveStructureIds(
    tenantId: string,
    mode: AvailabilityMode,
    selectedIds: string[],
    transaction?: Transaction
): Promise<string[]> {
    return mode === 'ALL' ? tenantStructureIds(tenantId, transaction) : selectedIds;
}

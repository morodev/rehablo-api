import {Request} from 'express';
import {Model, Op, Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {getGrantedPermissions, getSelectedStructureId, getUserId} from '../../../middleware/rbac.js';
import {resolveGrantedScope} from '../../auth/rbac/permissions.js';
import {TreasuryMovement} from '../models/index.js';
import {TreasuryCategory, TreasuryTag, TreasuryClassification, TreasuryMovementTag} from '../models/treasuryClassification.model.js';
import {isInternalTransfer} from './financialMovementPolicy.service.js';
import {assertFinancialAccess} from './financialOperations.service.js';
import {balanceEffectiveMovements} from './treasuryLedger.service.js';
import {resolveAdministrationDateRange, resolveAdministrationStructure} from './administrationQuery.service.js';
import {TREASURY_UUID, treasuryError} from './treasuryValidation.service.js';

type Row = Record<string, any>;
const plain = (row: Model): Row => row.get({plain: true});
const id = (value: unknown, label: string): string => {
    if (typeof value !== 'string' || !TREASURY_UUID.test(value)) treasuryError(label + ' non valido', 422);
    return (value as string).toLowerCase();
};
export function taxonomyValue(value: unknown, category: boolean, creating: boolean): Row {
    if (!value || typeof value !== 'object' || Array.isArray(value)) treasuryError('Dati non validi', 422);
    const source = value as Row, allowed = category ? ['name', 'direction', 'color', 'isActive'] : ['name', 'isActive'];
    if (Object.keys(source).some(key => !allowed.includes(key))) treasuryError('Campo non modificabile', 422);
    const result: Row = {};
    if (creating || source.name !== undefined) {
        if (typeof source.name !== 'string') treasuryError('Inserisci un nome', 422);
        const name = source.name.normalize('NFKC').trim().replace(/\s+/g, ' ');
        if (!name || name.length > 100) treasuryError('Il nome deve contenere da 1 a 100 caratteri', 422);
        result.name = name; result.normalizedName = name.toLocaleLowerCase('it');
    }
    if (category && (creating || source.direction !== undefined)) {
        if (!['IN', 'OUT'].includes(source.direction)) treasuryError('Scegli Entrate o Uscite', 422);
        result.direction = source.direction;
    }
    if (category && (creating || source.color !== undefined)) {
        const color = source.color ?? '#6366f1';
        if (typeof color !== 'string' || !/^#[a-f0-9]{6}$/i.test(color)) treasuryError('Colore non valido', 422);
        result.color = color.toLowerCase();
    }
    if (source.isActive !== undefined) {
        if (typeof source.isActive !== 'boolean') treasuryError('Stato non valido', 422);
        result.isActive = source.isActive;
    }
    return result;
}
export function classificationValue(value: unknown): {businessCategoryId: string | null; tagIds: string[]} {
    if (!value || typeof value !== 'object' || Array.isArray(value)) treasuryError('Classificazione non valida', 422);
    const source = value as Row;
    if (Object.keys(source).some(key => !['businessCategoryId', 'tagIds'].includes(key))) treasuryError('La classificazione non può modificare il movimento', 422);
    if (source.businessCategoryId !== null && typeof source.businessCategoryId !== 'string') treasuryError('Indica la categoria o lascia Da classificare', 422);
    if (!Array.isArray(source.tagIds) || source.tagIds.length > 50) treasuryError('Seleziona al massimo 50 tag', 422);
    return {businessCategoryId: source.businessCategoryId === null ? null : id(source.businessCategoryId, 'Categoria'),
        tagIds: [...new Set<string>(source.tagIds.map((value: unknown) => id(value, 'Tag')))].sort()};
}
export function classificationFilters(query: Row): {businessCategoryId: string | null; unclassified: boolean; tagIds: string[]; editableOnly: boolean} {
    if (query.classificationState != null && !['', 'unclassified'].includes(query.classificationState)) treasuryError('Filtro classificazione non valido', 400);
    if (query.classificationEditable != null && !['', 'true'].includes(query.classificationEditable)) treasuryError('Filtro classificazione modificabile non valido', 400);
    if (query.tagIds != null && typeof query.tagIds !== 'string') treasuryError('Filtro tag non valido', 400);
    if (query.businessCategoryId != null && typeof query.businessCategoryId !== 'string') treasuryError('Filtro categoria non valido', 400);
    const tagIds = query.tagIds ? String(query.tagIds).split(',') : [];
    if (tagIds.length > 50 || tagIds.some(value => !TREASURY_UUID.test(value))) treasuryError('Filtro tag non valido', 400);
    const businessCategoryId = query.businessCategoryId ? id(query.businessCategoryId, 'Categoria') : null;
    if (businessCategoryId && query.classificationState === 'unclassified') treasuryError('Filtri categoria discordanti', 400);
    return {businessCategoryId, unclassified: query.classificationState === 'unclassified', tagIds: [...new Set(tagIds.map(value => value.toLowerCase()))], editableOnly: query.classificationEditable === 'true'};
}
export function matchesClassification(row: Row, filters: ReturnType<typeof classificationFilters>): boolean {
    return (!filters.businessCategoryId || row.businessCategoryId === filters.businessCategoryId)
        && (!filters.unclassified || (!row.businessCategoryId && !isInternalTransfer(row)))
        && (!filters.editableOnly || row.classificationEditable === true)
        && (!filters.tagIds.length || filters.tagIds.some(tag => row.tagIds?.includes(tag)));
}
export function classificationEditable(req: Request, row: Row): boolean {
    if (isInternalTransfer(row) || row.reversalOfId) return false;
    const scope = req.user?.isSuperAdmin ? 'tenant' : resolveGrantedScope(getGrantedPermissions(req), 'treasury', 'update');
    return !!scope && (scope === 'tenant' || row.structureId === (getSelectedStructureId(req) ?? req.access?.structureId))
        && (scope !== 'own' || row.createdByUserId === getUserId(req));
}
export const taxonomyDto = (row: Row, movementCount = 0): Row => ({id: String(row.id), name: row.name,
    ...(row.direction ? {direction: row.direction, color: row.color} : {}), isActive: row.isActive !== false, movementCount});

/** Reversals inherit their original's classification, including when their dates differ. */
export async function decorateTreasuryClassification(req: Request, rows: Row[], transaction?: Transaction): Promise<Row[]> {
    if (!rows.length) return [];
    const schema = req.tenantSchema!;
    const originals = new Map(rows.map(row => [String(row.id), row]));
    const missingOriginals = [...new Set(rows.filter(row => row.reversalOfId && !originals.has(String(row.reversalOfId))).map(row => String(row.reversalOfId)))];
    if (missingOriginals.length) {
        for (const original of await TreasuryMovement.schema(schema).findAll({where: {id: {[Op.in]: missingOriginals}}, transaction})) originals.set(String(original.get('id')), plain(original));
    }
    const sourceId = (row: Row): string | null => {
        if (!row.reversalOfId) return String(row.id);
        const original = originals.get(String(row.reversalOfId));
        // A malformed historical reference must not reveal another account/site's metadata.
        return original && original.structureId === row.structureId && original.accountId === row.accountId
            && original.direction !== row.direction && Math.round(Number(original.amount) * 100) === Math.round(Number(row.amount) * 100)
            ? String(original.id) : null;
    };
    const ids = [...new Set(rows.map(sourceId).filter((value): value is string => !!value))];
    const [classifications, links, categories] = await Promise.all([
        TreasuryClassification.schema(schema).findAll({where: {movementId: {[Op.in]: ids}}, transaction}),
        TreasuryMovementTag.schema(schema).findAll({where: {movementId: {[Op.in]: ids}}, transaction}),
        TreasuryCategory.schema(schema).findAll({transaction}),
    ]);
    const byMovement = new Map(classifications.map(row => [String(row.get('movementId')), plain(row)]));
    const byCategory = new Map(categories.map(row => [String(row.get('id')), taxonomyDto(plain(row))]));
    const tags = new Map<string, string[]>();
    for (const link of links) {const key = String(link.get('movementId')); tags.set(key, [...(tags.get(key) ?? []), String(link.get('tagId'))]);}
    return rows.map(row => {
        const key = sourceId(row) ?? '', transfer = isInternalTransfer(row);
        const businessCategoryId = transfer ? null : byMovement.get(key)?.businessCategoryId ?? null;
        return {...row, businessCategoryId, businessCategory: byCategory.get(businessCategoryId) ?? null,
            tagIds: transfer ? [] : [...new Set(tags.get(key) ?? [])].sort(), classificationEditable: classificationEditable(req, row)};
    });
}

export function treasuryClassificationScope(req: Request): Row {
    if (req.query.structureId != null && typeof req.query.structureId !== 'string') treasuryError('Sede non valida', 400);
    const scope = resolveAdministrationStructure(req.access, req.query.structureId);
    return scope.kind === 'all' ? {} : {structureId: scope.kind === 'structure' ? scope.structureId : {[Op.in]: []}};
}
export async function readTaxonomy(req: Request): Promise<{categories: Row[]; tags: Row[]}> {
    const schema = req.tenantSchema!;
    const [categories, tags, movements] = await Promise.all([
        TreasuryCategory.schema(schema).findAll({order: [['name', 'ASC']]}),
        TreasuryTag.schema(schema).findAll({order: [['name', 'ASC']]}),
        TreasuryMovement.schema(schema).findAll({where: treasuryClassificationScope(req)})
    ]);
    const rows = await decorateTreasuryClassification(req, movements.map(plain));
    return {categories: categories.map(row => taxonomyDto(plain(row), rows.filter(item => item.businessCategoryId === String(row.get('id'))).length)),
        tags: tags.map(row => taxonomyDto(plain(row), rows.filter(item => item.tagIds.includes(String(row.get('id')))).length))};
}

export async function saveTaxonomy(req: Request, category: boolean): Promise<Row> {
    const schema = req.tenantSchema!, value = taxonomyValue(req.body, category, !req.params.id);
    const model = category ? TreasuryCategory : TreasuryTag;
    try {
        return await sequelize.transaction(async transaction => {
            const current = req.params.id ? await model.schema(schema).findByPk(id(req.params.id, 'Voce'), {transaction, lock: transaction.LOCK.UPDATE}) : null;
            if (req.params.id && !current) treasuryError('Voce non disponibile', 404);
            if (current && category && value.direction && value.direction !== current.get('direction')) {
                if (await TreasuryClassification.schema(schema).count({where: {businessCategoryId: current.get('id')}, transaction})) treasuryError('La categoria è già utilizzata. Crea una nuova categoria per un ambito diverso.', 409);
            }
            const row = current ? await current.update(value, {transaction}) : await model.schema(schema).create(value, {transaction});
            return taxonomyDto(plain(row));
        });
    } catch (error: any) {
        if (error?.name === 'SequelizeUniqueConstraintError') treasuryError('Esiste già una voce con questo nome, anche tra quelle archiviate', 409);
        throw error;
    }
}

export async function saveClassification(req: Request): Promise<Row> {
    const movementId = id(req.params.id, 'Movimento'), value = classificationValue(req.body), schema = req.tenantSchema!;
    return sequelize.transaction(async transaction => {
        // Serialize metadata writes on the existing ledger row without changing it.
        const movement = await TreasuryMovement.schema(schema).findByPk(movementId, {transaction, lock: transaction.LOCK.UPDATE});
        if (!movement) treasuryError('Movimento non disponibile', 404);
        const row = plain(movement);
        assertFinancialAccess(req, 'treasury', 'update', row.structureId, row.createdByUserId);
        if (row.reversalOfId || isInternalTransfer(row)) treasuryError(row.reversalOfId ? 'Classifica il movimento originale dello storno' : 'I giroconti non richiedono una categoria', 409);
        const current = await TreasuryClassification.schema(schema).findByPk(movementId, {transaction});
        const existingTags = await TreasuryMovementTag.schema(schema).findAll({where: {movementId}, transaction});
        if (value.businessCategoryId) {
            // Same row lock as archive/direction changes: an archived category cannot slip into a new assignment.
            const selected = await TreasuryCategory.schema(schema).findByPk(value.businessCategoryId, {transaction, lock: transaction.LOCK.UPDATE});
            if (!selected || selected.get('direction') !== row.direction || (!selected.get('isActive') && current?.get('businessCategoryId') !== value.businessCategoryId)) treasuryError('Categoria non disponibile per questo movimento', 422);
        }
        for (const tagId of value.tagIds) {
            const tag = await TreasuryTag.schema(schema).findByPk(tagId, {transaction, lock: transaction.LOCK.UPDATE});
            if (!tag || (!tag.get('isActive') && !existingTags.some(link => link.get('tagId') === tagId))) treasuryError('Tag non disponibile', 422);
        }
        const metadata = {businessCategoryId: value.businessCategoryId, updatedByUserId: getUserId(req)};
        if (current) await current.update(metadata, {transaction});
        else await TreasuryClassification.schema(schema).create({movementId, ...metadata}, {transaction});
        await TreasuryMovementTag.schema(schema).destroy({where: {movementId}, transaction});
        if (value.tagIds.length) await TreasuryMovementTag.schema(schema).bulkCreate(value.tagIds.map(tagId => ({movementId, tagId})), {transaction});
        return (await decorateTreasuryClassification(req, [row], transaction))[0];
    });
}

/** Pure projection uses integer cents and a single occurrence per ledger movement, even with multiple tags. */
export function categoryAnalysis(rows: Row[], direction: 'IN' | 'OUT'): Row {
    const economic = rows.filter(row => !isInternalTransfer(row));
    const income = economic.filter(row => row.direction === 'IN').reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0) / 100;
    const outcome = economic.filter(row => row.direction === 'OUT').reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0) / 100;
    const selected = economic.filter(row => row.direction === direction), groups = new Map<string | null, Row>();
    for (const row of selected) {
        const key = row.businessCategoryId ?? null;
        const group = groups.get(key) ?? {categoryId: key, name: row.businessCategory?.name ?? 'Da classificare', color: row.businessCategory?.color ?? '#d97706', amount: 0, movementCount: 0};
        group.amount += Math.round(Number(row.amount) * 100); group.movementCount++; groups.set(key, group);
    }
    const unclassified = selected.filter(row => !row.businessCategoryId);
    return {income, outcome, net: Math.round((income - outcome) * 100) / 100,
        movementCount: selected.length, classifiedCount: selected.length - unclassified.length,
        unclassifiedCount: unclassified.length, unclassifiedAmount: unclassified.reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0) / 100,
        groups: [...groups.values()].map((group): Row => ({...group, amount: group.amount / 100})).sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'it'))};
}
export async function readCategoryAnalysis(req: Request, scope: Row): Promise<Row> {
    for (const field of ['from', 'to', 'direction']) {
        if (req.query[field] != null && typeof req.query[field] !== 'string') treasuryError('Filtro report non valido', 400);
    }
    const filters = classificationFilters(req.query), period = resolveAdministrationDateRange(req.query.from, req.query.to);
    const direction = req.query.direction ?? 'OUT';
    if (!['IN', 'OUT'].includes(String(direction))) treasuryError('Direzione non valida', 400);
    if (req.query.accountId && (typeof req.query.accountId !== 'string' || !TREASURY_UUID.test(req.query.accountId))) treasuryError('Conto non valido', 400);
    const rows = (await TreasuryMovement.schema(req.tenantSchema!).findAll({where: {...scope, ...(req.query.accountId ? {accountId: req.query.accountId} : {})}})).map(plain);
    const effective = balanceEffectiveMovements(rows).filter(row => {
        const time = new Date(row.occurredAt).getTime();
        return (!period.fromInstant || time >= period.fromInstant.getTime()) && (!period.toInstant || time <= period.toInstant.getTime());
    });
    return categoryAnalysis((await decorateTreasuryClassification(req, effective)).filter(row => matchesClassification(row, filters)), direction as 'IN' | 'OUT');
}

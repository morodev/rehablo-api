import { Op } from 'sequelize';
import { Tenant, Structure } from '../../auth/models/index.js';
import Patient from '../../patients/models/patient.model.js';
import { PriceList, PriceListItem, PriceListVersion } from '../models/index.js';

export interface PriceResolutionInput {
    itemType: 'SERVICE' | 'PRODUCT';
    itemId: string;
    onDate: string;
    structureId?: string | null;
    patientId?: string | null;
    explicitPriceListId?: string | null;
    quantity?: number;
}

export interface PriceResolutionCandidate {
    priceListId: string;
    priceListName: string;
    priority: number;
    source: 'EXPLICIT' | 'PATIENT' | 'STRUCTURE' | 'TENANT' | 'DEFAULT';
}

export function choosePriceList(
    candidates: PriceResolutionCandidate[],
    preferredIds: Array<{ id?: string | null; source: PriceResolutionCandidate['source'] }>
): PriceResolutionCandidate | null {
    for (const preferred of preferredIds) {
        if (!preferred.id) continue;
        const match = candidates.find(candidate => candidate.priceListId === preferred.id);
        if (match) return { ...match, source: preferred.source };
    }
    return [...candidates].sort((a, b) => b.priority - a.priority)[0] ?? null;
}

export async function resolvePrice(schema: string, tenantId: string, input: PriceResolutionInput) {
    const onDate = input.onDate || new Date().toISOString().slice(0, 10);
    const [tenant, structure, patient, lists] = await Promise.all([
        Tenant.findByPk(tenantId, { attributes: ['defaultPriceListId'] }),
        input.structureId ? Structure.findByPk(input.structureId, { attributes: ['defaultPriceListId'] }) : null,
        input.patientId ? Patient.schema(schema).findByPk(input.patientId, { attributes: ['defaultPriceListId'] }) : null,
        PriceList.schema(schema).findAll({ where: { isActive: true }, order: [['priority', 'DESC']] })
    ]);
    const candidates: PriceResolutionCandidate[] = lists.map(list => ({
        priceListId: list.get('id') as string,
        priceListName: list.get('name') as string,
        priority: Number(list.get('priority') ?? 0),
        source: 'DEFAULT'
    }));
    const selected = choosePriceList(candidates, [
        { id: input.explicitPriceListId, source: 'EXPLICIT' },
        { id: patient?.get('defaultPriceListId') as string | null, source: 'PATIENT' },
        { id: structure?.get('defaultPriceListId') as string | null, source: 'STRUCTURE' },
        { id: tenant?.get('defaultPriceListId') as string | null, source: 'TENANT' },
        { id: lists.find(list => list.get('isDefault'))?.get('id') as string | undefined, source: 'DEFAULT' }
    ]);
    if (!selected) return null;

    const version = await PriceListVersion.schema(schema).findOne({
        where: {
            priceListId: selected.priceListId,
            status: 'PUBLISHED',
            validFrom: { [Op.lte]: onDate },
            [Op.or]: [{ validTo: null }, { validTo: { [Op.gte]: onDate } }]
        },
        order: [['version', 'DESC']]
    });
    if (!version) return null;

    const item = await PriceListItem.schema(schema).findOne({
        where: {
            priceListVersionId: version.get('id'),
            itemType: input.itemType,
            itemId: input.itemId,
            minQuantity: { [Op.lte]: Math.max(1, input.quantity ?? 1) },
            [Op.or]: [{ structureId: input.structureId ?? null }, { structureId: null }]
        },
        order: [['structureId', 'DESC'], ['minQuantity', 'DESC']]
    });
    if (!item) return null;
    return {
        ...selected,
        versionId: version.get('id'),
        version: version.get('version'),
        priceListItemId: item.get('id'),
        unitPrice: Number(item.get('unitPrice')),
        vatRate: item.get('vatRate') === null ? null : Number(item.get('vatRate')),
        vatNature: item.get('vatNature'),
        onDate
    };
}

import {Request} from 'express';
import {Model, Op, Transaction} from 'sequelize';
import {getUserId} from '../../../middleware/rbac.js';
import Service from '../../products-services/models/service.model.js';
import ServiceStructure from '../../products-services/models/serviceStructure.model.js';
import {availabilityWhere} from '../../products-services/services/structureAvailability.service.js';

type Plain = Record<string, any>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (message: string, statusCode = 409): never => {throw Object.assign(new Error(message), {statusCode});};
const units = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export interface PackageBookingService {serviceId: string; serviceName: string; purchasedUnits: number; remainingUnits: number;}
export interface PackageBookingLine {lineId: string; description: string; quantity: number; serviceId: string | null;}
export interface PackageBookingState {
    status: 'READY' | 'NEEDS_SETUP'; reason: string | null; services: PackageBookingService[];
    setupLines: PackageBookingLine[]; unallocatedConsumedUnits: number;
}
export interface PackageBookingSetupInput {
    expectedRemainingUnits: number; expectedUpdatedAt: string;
    lines: Array<{lineId: string; serviceId: string}>;
    remainingByService: Array<{serviceId: string; remainingUnits: number}>;
}

function bookingLines(pack: Plain): PackageBookingLine[] {
    const lines = (Array.isArray(pack.lines) ? pack.lines : []).map((line: Plain, index: number) => ({line, index}))
        .filter(({line}: {line: Plain}) => line.itemType === 'SERVICE')
        .map(({line, index}: {line: Plain; index: number}) => ({lineId: typeof line.id === 'string' && line.id ? line.id : `line-${index}`,
            description: String(line.description ?? pack.name ?? 'Sedute'), quantity: Number(line.quantity),
            serviceId: typeof line.itemId === 'string' && uuid.test(line.itemId) ? line.itemId : null}));
    // A package with no surviving service rows still has an explicit total of purchased sessions.
    return lines.length ? lines : [{lineId: 'package', description: String(pack.name ?? 'Sedute'),
        quantity: Number(pack.purchasedUnits), serviceId: typeof pack.serviceId === 'string' && uuid.test(pack.serviceId) ? pack.serviceId : null}];
}

function groupLines(lines: PackageBookingLine[]): PackageBookingService[] {
    const services = new Map<string, PackageBookingService>();
    for (const line of lines) {
        if (!line.serviceId) continue;
        const previous = services.get(line.serviceId);
        if (previous) {previous.purchasedUnits += line.quantity; previous.remainingUnits += line.quantity;}
        else services.set(line.serviceId, {serviceId: line.serviceId, serviceName: line.description,
            purchasedUnits: line.quantity, remainingUnits: line.quantity});
    }
    return [...services.values()];
}

/** Read-only derivation. A list request must never activate or repair a package. */
export function packageBookingState(pack: Plain): PackageBookingState {
    const purchased = Number(pack.purchasedUnits), remaining = Number(pack.remainingUnits);
    const setupLines = bookingLines(pack);
    const missing = (reason: string, services: PackageBookingService[] = []): PackageBookingState => ({status: 'NEEDS_SETUP', reason,
        services, setupLines, unallocatedConsumedUnits: units(purchased) && units(remaining) ? Math.max(0, purchased - remaining) : 0});
    if (!units(purchased) || purchased < 1 || !units(remaining) || remaining > purchased) return missing('Le quantità del pacchetto non sono coerenti.');
    if (pack.templateId) {
        if (typeof pack.serviceId !== 'string' || !uuid.test(pack.serviceId)) return missing('Collega la prestazione del pacchetto.');
        return {status: 'READY', reason: null, services: [{serviceId: pack.serviceId,
            serviceName: String(pack.serviceName ?? pack.name ?? 'Prestazione'), purchasedUnits: purchased, remainingUnits: remaining}],
            setupLines, unallocatedConsumedUnits: 0};
    }
    const stored = pack.purchaseSnapshot?.booking;
    if (stored != null) {
        const rows = Array.isArray(stored.services) ? stored.services : [];
        const valid = stored.version === 1 && rows.length > 0 && rows.every((row: Plain) => typeof row.serviceId === 'string'
            && uuid.test(row.serviceId) && units(row.purchasedUnits) && row.purchasedUnits > 0 && units(row.remainingUnits)
            && row.remainingUnits <= row.purchasedUnits) && new Set(rows.map((row: Plain) => row.serviceId)).size === rows.length
            && rows.reduce((sum: number, row: Plain) => sum + row.purchasedUnits, 0) === purchased
            && rows.reduce((sum: number, row: Plain) => sum + row.remainingUnits, 0) === remaining;
        if (!valid) return missing('Le quantità per prestazione sono cambiate: ricarica il pacchetto.');
        return {status: 'READY', reason: null, services: rows.map((row: Plain) => ({serviceId: row.serviceId,
            serviceName: String(row.serviceName ?? 'Prestazione'), purchasedUnits: row.purchasedUnits, remainingUnits: row.remainingUnits})),
            setupLines, unallocatedConsumedUnits: 0};
    }
    if (new Set(setupLines.map(line => line.lineId)).size !== setupLines.length
        || setupLines.some(line => !units(line.quantity) || line.quantity < 1)
        || setupLines.reduce((sum, line) => sum + line.quantity, 0) !== purchased) return missing('Le quantità delle prestazioni non corrispondono alle sedute acquistate.');
    const services = groupLines(setupLines);
    if (setupLines.some(line => !line.serviceId)) return missing('Collega le prestazioni indicate nel preventivo.');
    if (services.length === 1) services[0].remainingUnits = remaining;
    else if (remaining !== purchased) return missing('Indica quali sedute sono già state utilizzate per ciascuna prestazione.');
    return {status: 'READY', reason: null, services, setupLines, unallocatedConsumedUnits: 0};
}

/** Caller holds the patient and package row locks. Existing financial snapshot fields are preserved. */
export async function ensurePackageBooking(pack: Model, transaction: Transaction, actorId?: string): Promise<PackageBookingState> {
    const plain = pack.get({plain: true}) as Plain, state = packageBookingState(plain);
    if (plain.templateId || state.status !== 'READY' || plain.purchaseSnapshot?.booking) return state;
    await pack.update({purchaseSnapshot: {...(plain.purchaseSnapshot ?? {}), booking: {version: 1, services: state.services,
        mappings: state.setupLines.map(line => ({lineId: line.lineId, serviceId: line.serviceId})),
        configuredAt: new Date().toISOString(), configuredByUserId: actorId ?? null, automatic: true}}}, {transaction});
    return state;
}

/** Explicit clinical setup only; it does not create receipts, invoices or change the aggregate residual. */
export async function configurePackageBooking(req: Request, pack: Model, input: PackageBookingSetupInput,
    transaction: Transaction): Promise<PackageBookingState> {
    const plain = pack.get({plain: true}) as Plain, before = packageBookingState(plain);
    if (plain.templateId || before.status === 'READY') fail('Le prestazioni del pacchetto sono già definite. Ricarica i dati.');
    const stamp = new Date(plain.updatedAt).getTime();
    if (!input || !units(input.expectedRemainingUnits) || input.expectedRemainingUnits !== Number(plain.remainingUnits)
        || typeof input.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(input.expectedUpdatedAt))
        || !Number.isFinite(stamp) || Date.parse(input.expectedUpdatedAt) !== stamp) fail('Il pacchetto è cambiato: ricarica prima di confermare.');
    if (!Array.isArray(input.lines) || input.lines.length !== before.setupLines.length
        || new Set(input.lines.map(line => line?.lineId)).size !== input.lines.length
        || input.lines.some(line => typeof line?.lineId !== 'string' || typeof line?.serviceId !== 'string' || !uuid.test(line.serviceId))) fail('Collega una prestazione valida a ogni riga.', 422);
    const mapped = before.setupLines.map(line => ({...line, serviceId: input.lines.find(mapping => mapping.lineId === line.lineId)?.serviceId ?? null}));
    if (mapped.some(line => !line.serviceId || !units(line.quantity) || line.quantity < 1)
        || mapped.reduce((sum, line) => sum + line.quantity, 0) !== Number(plain.purchasedUnits)) fail('Le quantità delle prestazioni non corrispondono alle sedute acquistate.', 422);
    const services = groupLines(mapped);
    if (!Array.isArray(input.remainingByService) || input.remainingByService.length !== services.length
        || new Set(input.remainingByService.map(row => row?.serviceId)).size !== services.length) fail('Indica le sedute residue per ogni prestazione.', 422);
    for (const service of services) {
        const row = input.remainingByService.find(row => row?.serviceId === service.serviceId);
        if (!row || !units(row.remainingUnits) || row.remainingUnits > service.purchasedUnits) fail('Le sedute residue della prestazione non sono valide.', 422);
        service.remainingUnits = row!.remainingUnits;
    }
    if (services.reduce((sum, service) => sum + service.remainingUnits, 0) !== Number(plain.remainingUnits)) fail('La somma delle sedute residue deve restare uguale al residuo del pacchetto.', 422);
    const records = await Service.schema(req.tenantSchema!).findAll({where: {[Op.and]: [
        {id: {[Op.in]: services.map(service => service.serviceId)}, isActive: true},
        await availabilityWhere(ServiceStructure, req.tenantSchema!, 'serviceId', plain.structureId)]}, attributes: ['id', 'name'], transaction});
    const byId = new Map(records.map(record => [String(record.get('id')), record]));
    if (services.some(service => !byId.has(service.serviceId))) fail('Una prestazione non è disponibile nella sede del pacchetto.', 422);
    services.forEach(service => {service.serviceName = String(byId.get(service.serviceId)!.get('name'));});
    const at = new Date().toISOString(), byUserId = getUserId(req);
    const booking = {version: 1, services, mappings: mapped.map(line => ({lineId: line.lineId, serviceId: line.serviceId})),
        configuredAt: at, configuredByUserId: byUserId, automatic: false};
    await pack.update({purchaseSnapshot: {...(plain.purchaseSnapshot ?? {}), booking,
        bookingAudit: [...(Array.isArray(plain.purchaseSnapshot?.bookingAudit) ? plain.purchaseSnapshot.bookingAudit : []),
            {at, byUserId, before: {remainingUnits: plain.remainingUnits, services: before.services, lines: before.setupLines}, after: booking}]}}, {transaction});
    return packageBookingState(pack.get({plain: true}) as Plain);
}

/** Atomic cached counters mirror the immutable consumption/reversal ledger. */
export async function changePackageBookingUnits(pack: Model, serviceId: string, delta: 1 | -1,
    transaction: Transaction, actorId?: string): Promise<void> {
    const state = await ensurePackageBooking(pack, transaction, actorId);
    if (state.status !== 'READY') fail(state.reason!);
    const service = state.services.find(service => service.serviceId === serviceId);
    if (!service || service.remainingUnits + delta < 0 || service.remainingUnits + delta > service.purchasedUnits) fail('Sedute residue insufficienti per questa prestazione.');
    const plain = pack.get({plain: true}) as Plain, remainingUnits = Number(plain.remainingUnits) + delta;
    if (remainingUnits < 0 || remainingUnits > Number(plain.purchasedUnits)) fail('Le quantità del pacchetto non sono coerenti.');
    const changes: Plain = {remainingUnits, status: remainingUnits === 0 ? 'EXHAUSTED' : 'ACTIVE'};
    if (!plain.templateId) {
        const services = state.services.map(row => row.serviceId === serviceId ? {...row, remainingUnits: row.remainingUnits + delta} : row);
        changes.purchaseSnapshot = {...plain.purchaseSnapshot, booking: {...plain.purchaseSnapshot.booking, services}};
    }
    await pack.update(changes, {transaction});
}

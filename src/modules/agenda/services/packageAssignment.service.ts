import {Request} from 'express';
import {Op, Transaction} from 'sequelize';
import {getGrantedPermissions} from '../../../middleware/rbac.js';
import {resolveGrantedScope} from '../../auth/rbac/permissions.js';
import AgendaEvent from '../models/agendaEvent.model.js';
import EventType from '../models/eventType.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import {CarePackage, PackageConsumption} from '../../administration/models/administration.model.js';
import {packagePatient} from '../../administration/services/carePackage.service.js';
import {changePackageBookingUnits, ensurePackageBooking, packageBookingState, PackageBookingState} from '../../administration/services/packageBooking.service.js';
import {canAccessAppointmentFinance} from './appointmentFinancialAccess.service.js';

const fail = (message: string, statusCode = 409): never => {throw Object.assign(new Error(message), {statusCode});};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const packageCoversAppointment = (event: Record<string, any>): boolean => !!event.carePackageId
    && ['RESERVED', 'CONSUMED'].includes(event.packageReservationStatus);

export function appointmentPackageDate(start: unknown): string | null {
    const date = new Date(String(start ?? ''));
    return Number.isFinite(date.getTime()) ? date.toLocaleDateString('en-CA', {timeZone: 'Europe/Rome'}) : null;
}

function serviceForContext(pkg: Record<string, any>, current: Record<string, any> | null | undefined,
    context: {patientId: string; structureId: string; agendaEventId?: string; eventTypeId?: string}, linkedServiceId: string | null): string | null {
    return current?.id === context.agendaEventId && (current?.patientId ?? current?.patient?.id) === context.patientId
        && current?.structureId === context.structureId && current?.carePackageId === pkg.id
        && current?.eventTypeId === context.eventTypeId && current?.carePackageServiceId
        ? current.carePackageServiceId : linkedServiceId;
}

export function packageCompatibilityError(pkg: Record<string, any>, event: Record<string, any>, serviceId: string | null): string | null {
    if (!['ACTIVE', 'EXHAUSTED'].includes(pkg.status)) return 'Il pacchetto non è attivo.';
    if (pkg.patientId !== (event.patientId ?? event.patient?.id) || pkg.structureId !== event.structureId) return 'Il pacchetto appartiene a un altro paziente o a un’altra sede.';
    const booking = packageBookingState(pkg);
    if (booking.status !== 'READY') return booking.reason;
    if (!event.eventTypeId) return 'Seleziona il tipo di appuntamento per verificare la compatibilità del pacchetto.';
    if (!serviceId) return 'Seleziona un tipo di appuntamento collegato a una prestazione.';
    if (!booking.services.some(service => service.serviceId === serviceId)) return 'La prestazione dell’appuntamento non è compresa nel pacchetto.';
    if (event.recurrence || event.recurringEventId) return 'Separa questa occorrenza dalla serie prima di assegnare il pacchetto.';
    if (!event.start) return 'Imposta la data della seduta per verificare la validità del pacchetto.';
    const day = appointmentPackageDate(event.start);
    if (!day) return 'La data della seduta non è valida per questo pacchetto.';
    if (pkg.purchasedAt && day < String(pkg.purchasedAt).slice(0, 10)) return 'Il pacchetto non era ancora stato acquistato alla data della seduta.';
    if (pkg.expiresAt && day > String(pkg.expiresAt).slice(0, 10)) return 'Il pacchetto è scaduto alla data della seduta.';
    return null;
}

/** Null service snapshots conservatively reserve capacity in every service, until repaired. */
export async function reservedPackageUnits(schema: string, packageId: string, transaction?: Transaction,
    excludeEventId?: string, serviceId?: string, allowedServiceIds?: string[]): Promise<number> {
    return AgendaEvent.schema(schema).count({where: {carePackageId: packageId, packageReservationStatus: 'RESERVED',
        ...(excludeEventId ? {id: {[Op.ne]: excludeEventId}} : {}),
        ...(serviceId ? {[Op.or]: [{carePackageServiceId: serviceId}, {carePackageServiceId: null},
            ...(allowedServiceIds?.length ? [{carePackageServiceId: {[Op.notIn]: allowedServiceIds}}] : [])]} : {})}, transaction});
}

async function authorizePackage(req: Request, pkg: Record<string, any>, event: Record<string, any>, transaction: Transaction) {
    if (pkg.templateId) {
        if (!canAccessAppointmentFinance(req, event, 'care_package', 'read')) fail('Non puoi gestire il pacchetto di questa seduta.', 403);
    } else {
        const patient = await packagePatient(req, pkg.patientId, 'quote', 'read', transaction);
        if (patient.get('structureId') !== pkg.structureId || pkg.structureId !== event.structureId
            || pkg.patientId !== (event.patientId ?? event.patient?.id)) fail('Pacchetto non disponibile.', 404);
    }
}

/** Caller owns the patient and event locks. All package transitions lock packages in ID order. */
export async function syncPackageAssignment(req: Request, event: AgendaEvent, patch: Record<string, any>, transaction: Transaction,
    options: {newEvent?: boolean} = {}): Promise<void> {
    const schema = req.tenantSchema!, previous = event.get({plain: true});
    const next = {...previous, ...patch};
    const previousId = previous.carePackageId || null;
    const requested = Object.prototype.hasOwnProperty.call(patch, 'carePackageId') ? patch.carePackageId : previousId;
    if (requested != null && (typeof requested !== 'string' || !uuid.test(requested))) fail('Pacchetto non valido.', 422);
    const targetId = requested || null;
    if (!previousId && !targetId) {patch.carePackageId = null; patch.carePackageServiceId = null; patch.packageReservationStatus = null; return;}
    const quoteRead = req.user?.isSuperAdmin || !!resolveGrantedScope(getGrantedPermissions(req), 'quote', 'read');
    if (!canAccessAppointmentFinance(req, next, 'care_package', 'read') && !quoteRead) fail('Non puoi gestire il pacchetto di questa seduta.', 403);
    const desired = targetId ? ['CANCELLED', 'NO_SHOW'].includes(String(next.status).toUpperCase()) ? 'RELEASED'
        : String(next.status).toUpperCase() === 'COMPLETED' ? 'CONSUMED' : 'RESERVED' : null;
    if (!options.newEvent && targetId && desired === 'CONSUMED' && previousId !== targetId && String(previous.status).toUpperCase() === 'COMPLETED') {
        fail('Riapri la seduta prima di assegnare o cambiare il pacchetto, poi segnala esplicitamente che è stata effettuata.');
    }
    const ids = [...new Set([previousId, targetId].filter((id): id is string => !!id))].sort();
    const packages = await CarePackage.schema(schema).findAll({where: {id: {[Op.in]: ids}}, order: [['id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE});
    const byId = new Map(packages.map(pkg => [String(pkg.get('id')), pkg]));
    const target = targetId ? byId.get(targetId) : null;
    if (targetId && !target) fail('Pacchetto non disponibile.', 404);
    const old = previousId ? byId.get(previousId) : undefined;
    if (old) await authorizePackage(req, old.get({plain: true}), previous, transaction);
    if (target) await authorizePackage(req, target.get({plain: true}), next, transaction);
    let targetServiceId: string | null = null;
    if (target && (desired !== 'RELEASED' || targetId !== previousId)) {
        if (next.invoiceId) fail('La seduta è già fatturata.');
        const sameServiceAgreement = previousId === targetId && (patch.eventTypeId === undefined || patch.eventTypeId === previous.eventTypeId) && previous.carePackageServiceId;
        const type = sameServiceAgreement ? null : next.eventTypeId ? await EventType.schema(schema).findByPk(next.eventTypeId, {transaction}) : null;
        targetServiceId = sameServiceAgreement || type?.linkedServiceId || null;
        const error = packageCompatibilityError(target.get({plain: true}), next, targetServiceId);
        if (error) fail(error);
        if (desired === 'CONSUMED' && Date.parse(next.start ?? '') > Date.now()) fail('Una seduta futura non può essere segnata come effettuata.');
        if (!previousId && !target.get('templateId')) {
            const consumed = await PackageConsumption.schema(schema).findOne({where: {agendaEventId: event.id, status: 'POSTED', type: 'CONSUME'}, transaction});
            const coverage = consumed ? null : await InvoicePayment.schema(schema).findOne({where: {agendaEventId: event.id, source: 'PACKAGE', status: 'POSTED'}, transaction});
            if (consumed || coverage) fail('Questa seduta è già stata utilizzata da un pacchetto. Correggi la registrazione esistente prima di assegnarla.');
        }
        const booking = await ensurePackageBooking(target, transaction, req.access?.userId);
        if (booking.status !== 'READY') fail(booking.reason!);
    }
    const wasConsumed = previous.packageReservationStatus === 'CONSUMED';
    const oldServices = old ? packageBookingState(old.get({plain: true})).services : [];
    const oldServiceId = previous.carePackageServiceId ?? (oldServices.length === 1 ? oldServices[0].serviceId : null);
    const remainsConsumed = wasConsumed && previousId === targetId && desired === 'CONSUMED' && oldServiceId === targetServiceId;
    if (wasConsumed && !remainsConsumed) {
        const original = await PackageConsumption.schema(schema).findOne({where: {packageId: previousId, agendaEventId: event.id,
            status: 'POSTED', type: 'CONSUME'}, transaction, lock: transaction.LOCK.UPDATE});
        if (!original) fail('La registrazione della seduta non è disponibile per la correzione.');
        if (!old) fail('Pacchetto originale non disponibile.');
        const serviceId = String(original!.get('serviceId') ?? oldServiceId ?? '');
        if (!uuid.test(serviceId)) fail('Collega la prestazione della seduta prima di ripristinarla.');
        await original!.update({status: 'REVERSED'}, {transaction});
        await PackageConsumption.schema(schema).create({packageId: previousId, agendaEventId: event.id, units: 1, serviceId,
            type: 'REVERSE', reversalOfId: original!.get('id'), status: 'POSTED', createdByUserId: req.access?.userId,
            note: 'Ripristino per correzione dell’esito in agenda'}, {transaction});
        await changePackageBookingUnits(old!, serviceId, 1, transaction, req.access?.userId);
    }
    if (target && desired !== 'RELEASED' && !remainsConsumed) {
        const reserved = await reservedPackageUnits(schema, targetId!, transaction, event.id);
        const services = packageBookingState(target.get({plain: true})).services;
        const serviceReserved = target.get('templateId') ? reserved : await reservedPackageUnits(schema, targetId!, transaction, event.id, targetServiceId!, services.map(row => row.serviceId));
        const service = services.find(service => service.serviceId === targetServiceId);
        if (Number(target.get('remainingUnits')) - reserved < 1) fail('Tutte le sedute del pacchetto sono già utilizzate o prenotate.');
        if (!service || service.remainingUnits - serviceReserved < 1) fail('Le sedute di questa prestazione sono già utilizzate o prenotate.');
        if (desired === 'CONSUMED') {
            await PackageConsumption.schema(schema).create({packageId: targetId, agendaEventId: event.id, units: 1, serviceId: targetServiceId,
                type: 'CONSUME', status: 'POSTED', createdByUserId: req.access?.userId, note: 'Seduta effettuata in agenda'}, {transaction});
            await changePackageBookingUnits(target, targetServiceId!, -1, transaction, req.access?.userId);
        }
    }
    patch.carePackageId = targetId;
    patch.carePackageServiceId = targetId ? targetServiceId ?? previous.carePackageServiceId ?? oldServiceId ?? null : null;
    patch.packageReservationStatus = desired;
}

export async function eligibleCarePackages(schema: string, context: {patientId: string; structureId: string; eventTypeId: string; start: string;
    agendaEventId?: string; includeLegacy?: boolean; includeCatalog?: boolean}, transaction?: Transaction) {
    const type = await EventType.schema(schema).findByPk(context.eventTypeId, {transaction});
    if (!type?.linkedServiceId) return [];
    const packages = await CarePackage.schema(schema).findAll({where: {patientId: context.patientId, structureId: context.structureId,
        ...(!context.includeLegacy ? {templateId: {[Op.ne]: null}} : {}), status: {[Op.in]: ['ACTIVE', 'EXHAUSTED']}}, order: [['expiresAt', 'ASC'], ['createdAt', 'ASC']], transaction});
    const currentModel = context.agendaEventId ? await AgendaEvent.schema(schema).findByPk(context.agendaEventId, {transaction}) : null;
    const current = currentModel?.get ? currentModel.get({plain: true}) : currentModel;
    const result: Array<{id: string; name: string; serviceId: string; serviceName: string; purchasedUnits: number;
        remainingUnits: number; reservedUnits: number; availableUnits: number; expiresAt: string | null}> = [];
    for (const model of packages) {
        const pkg = model.get({plain: true});
        const serviceId = serviceForContext(pkg, current, context, type.linkedServiceId);
        if ((pkg.templateId ? context.includeCatalog === false : !context.includeLegacy) || packageCompatibilityError(pkg, context, serviceId)) continue;
        const services = packageBookingState(pkg).services;
        const service = services.find(service => service.serviceId === serviceId)!;
        const reservedUnits = await reservedPackageUnits(schema, pkg.id, transaction, context.agendaEventId);
        const serviceReserved = pkg.templateId ? reservedUnits : await reservedPackageUnits(schema, pkg.id, transaction, context.agendaEventId, service.serviceId, services.map(row => row.serviceId));
        const retained = current?.carePackageId === pkg.id && current?.packageReservationStatus === 'CONSUMED'
            && (current.carePackageServiceId ?? (packageBookingState(pkg).services.length === 1 ? service.serviceId : null)) === service.serviceId ? 1 : 0;
        const availableUnits = Math.max(0, Math.min(Number(pkg.remainingUnits) - reservedUnits + retained, service.remainingUnits - serviceReserved + retained));
        if (availableUnits > 0) result.push({id: pkg.id, name: pkg.name, serviceId: service.serviceId, serviceName: service.serviceName,
            purchasedUnits: Number(pkg.purchasedUnits), remainingUnits: Number(pkg.remainingUnits), reservedUnits, availableUnits, expiresAt: pkg.expiresAt});
    }
    return result;
}

export interface AppointmentPackageOptionsContext {
    patientId: string; structureId: string; calendarId: string; eventTypeId?: string; start?: string; agendaEventId?: string;
    recurring?: boolean; includeLegacy?: boolean; includeCatalog?: boolean; currentEvent?: Record<string, any>;
}
export interface AppointmentPackageOption {
    id: string; name: string; serviceId: string | null; serviceName: string | null;
    purchasedUnits: number; remainingUnits: number; reservedUnits: number; availableUnits: number;
    expiresAt: string | null; selectable: boolean; reason: string | null;
    origin: 'CATALOG' | 'QUOTE' | 'OTHER'; quoteId: string | null;
    booking: Omit<PackageBookingState, 'services'> & {services: Array<PackageBookingState['services'][number] & {reservedUnits: number; availableUnits: number}>};
}

/** A contextual preview only. Saving still owns the locks and revalidates compatibility and capacity. */
export async function appointmentCarePackageOptions(schema: string, context: AppointmentPackageOptionsContext,
    transaction?: Transaction): Promise<AppointmentPackageOption[]> {
    const type = context.eventTypeId ? await EventType.schema(schema).findByPk(context.eventTypeId, {transaction}) : null;
    const packageModels = await CarePackage.schema(schema).findAll({where: {patientId: context.patientId, structureId: context.structureId,
        ...(!context.includeLegacy ? {templateId: {[Op.ne]: null}} : {})}, order: [['expiresAt', 'ASC'], ['createdAt', 'ASC'], ['id', 'ASC']], transaction});
    const packages = packageModels.map(model => model.get({plain: true})).filter(pkg => pkg.patientId === context.patientId
        && pkg.structureId === context.structureId && (pkg.templateId ? context.includeCatalog !== false : context.includeLegacy));
    const ids = packages.map(pkg => pkg.id);
    const reservations = ids.length ? await AgendaEvent.schema(schema).findAll({where: {
        carePackageId: {[Op.in]: ids}, packageReservationStatus: 'RESERVED',
        ...(context.agendaEventId ? {id: {[Op.ne]: context.agendaEventId}} : {})
    }, attributes: ['carePackageId', 'carePackageServiceId'], transaction}) : [];
    const counts = new Map<string, number>(), byService = new Map<string, number>(), unknown = new Map<string, number>();
    const serviceIds = new Map(packages.map(pkg => [String(pkg.id), new Set(packageBookingState(pkg).services.map(row => row.serviceId))]));
    reservations.forEach(model => {
        const id = String(model.get('carePackageId')), serviceId = model.get('carePackageServiceId');
        counts.set(id, (counts.get(id) ?? 0) + 1);
        const known = serviceId && serviceIds.get(id)?.has(String(serviceId));
        const map = known ? byService : unknown, key = known ? `${id}:${serviceId}` : id;
        map.set(key, (map.get(key) ?? 0) + 1);
    });
    const current = context.currentEvent;
    const event = {...current, patientId: context.patientId, structureId: context.structureId, calendarId: context.calendarId,
        eventTypeId: context.eventTypeId, start: context.start, ...(context.recurring ? {recurrence: 'REQUESTED'} : {})};
    return packages.map(pkg => {
        const serviceId = serviceForContext(pkg, current, context, type?.linkedServiceId ?? null);
        const booking = packageBookingState(pkg), service = booking.services.find(service => service.serviceId === serviceId);
        const reservedUnits = counts.get(String(pkg.id)) ?? 0, remainingUnits = Number(pkg.remainingUnits) || 0;
        const retained = current?.id === context.agendaEventId && (current?.patientId ?? current?.patient?.id) === context.patientId
            && current?.structureId === context.structureId && current?.carePackageId === pkg.id && current?.packageReservationStatus === 'CONSUMED'
            && !!service && (current.carePackageServiceId ?? (booking.services.length === 1 ? service.serviceId : null)) === service.serviceId ? 1 : 0;
        const serviceReserved = service ? (byService.get(`${pkg.id}:${service.serviceId}`) ?? 0) + (unknown.get(String(pkg.id)) ?? 0) : 0;
        const availableUnits = service ? Math.max(0, Math.min(remainingUnits - reservedUnits + retained, service.remainingUnits - serviceReserved + retained)) : 0;
        let reason = packageCompatibilityError(pkg, event, serviceId);
        if (!reason && current?.invoiceId) reason = 'La seduta è già fatturata.';
        if (!reason && current && String(current.status).toUpperCase() === 'COMPLETED' && current.carePackageId !== pkg.id) reason = 'Riapri la seduta prima di assegnare o cambiare il pacchetto, poi segnala esplicitamente che è stata effettuata.';
        if (!reason && availableUnits < 1) reason = remainingUnits <= 0 ? 'Non restano sedute da utilizzare in questo pacchetto.'
            : service && service.remainingUnits <= 0 ? 'Non restano sedute da utilizzare per questa prestazione.' : 'Le sedute residue sono già tutte prenotate.';
        const single = booking.services.length === 1 ? booking.services[0] : undefined;
        const bookingServices = booking.services.map(row => {
            const reserved = (byService.get(`${pkg.id}:${row.serviceId}`) ?? 0) + (unknown.get(String(pkg.id)) ?? 0);
            const restored = retained && row.serviceId === service?.serviceId ? 1 : 0;
            return {...row, reservedUnits: reserved, availableUnits: Math.max(0, Math.min(remainingUnits - reservedUnits + restored, row.remainingUnits - reserved + restored))};
        });
        return {id: String(pkg.id), name: String(pkg.name ?? 'Pacchetto'), serviceId: service?.serviceId ?? single?.serviceId ?? null,
            serviceName: service?.serviceName ?? single?.serviceName ?? null, purchasedUnits: Number(pkg.purchasedUnits) || 0,
            remainingUnits, reservedUnits, availableUnits, expiresAt: pkg.expiresAt ? String(pkg.expiresAt).slice(0, 10) : null, selectable: !reason, reason,
            origin: pkg.quoteId ? 'QUOTE' as const : pkg.templateId ? 'CATALOG' as const : 'OTHER' as const, quoteId: pkg.quoteId ?? null,
            booking: {...booking, services: bookingServices}};
    }).sort((left, right) => Number(right.selectable) - Number(left.selectable));
}

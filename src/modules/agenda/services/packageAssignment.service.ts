import {Request} from 'express';
import {Op, Transaction} from 'sequelize';
import AgendaEvent from '../models/agendaEvent.model.js';
import EventType from '../models/eventType.model.js';
import {CarePackage, PackageConsumption} from '../../administration/models/administration.model.js';
import {canAccessAppointmentFinance} from './appointmentFinancialAccess.service.js';

const fail = (message: string, statusCode = 409): never => {throw Object.assign(new Error(message), {statusCode});};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const packageCoversAppointment = (event: Record<string, any>): boolean => !!event.carePackageId
    && ['RESERVED', 'CONSUMED'].includes(event.packageReservationStatus);

export function appointmentPackageDate(start: unknown): string | null {
    const date = new Date(String(start ?? ''));
    return Number.isFinite(date.getTime()) ? date.toLocaleDateString('en-CA', {timeZone: 'Europe/Rome'}) : null;
}

export function packageCompatibilityError(pkg: Record<string, any>, event: Record<string, any>, serviceId: string | null): string | null {
    if (!pkg.templateId) return 'Questo pacchetto precedente non è abilitato alla prenotazione in agenda.';
    if (!['ACTIVE', 'EXHAUSTED'].includes(pkg.status)) return 'Il pacchetto non è attivo.';
    if (pkg.patientId !== (event.patientId ?? event.patient?.id) || pkg.structureId !== event.structureId) return 'Il pacchetto appartiene a un altro paziente o a un’altra sede.';
    if (!event.eventTypeId) return 'Seleziona il tipo di appuntamento per verificare la compatibilità del pacchetto.';
    if (!serviceId) return 'Seleziona un tipo di appuntamento collegato a una prestazione.';
    if (serviceId !== pkg.serviceId) return 'La prestazione dell’appuntamento non è compresa nel pacchetto.';
    if (event.recurrence || event.recurringEventId) return 'Separa questa occorrenza dalla serie prima di assegnare il pacchetto.';
    if (!event.start) return 'Imposta la data della seduta per verificare la validità del pacchetto.';
    const day = appointmentPackageDate(event.start);
    if (!day) return 'La data della seduta non è valida per questo pacchetto.';
    if (pkg.purchasedAt && day < String(pkg.purchasedAt).slice(0, 10)) return 'Il pacchetto non era ancora stato acquistato alla data della seduta.';
    if (pkg.expiresAt && day > String(pkg.expiresAt).slice(0, 10)) return 'Il pacchetto è scaduto alla data della seduta.';
    return null;
}

export async function reservedPackageUnits(schema: string, packageId: string, transaction?: Transaction, excludeEventId?: string): Promise<number> {
    return AgendaEvent.schema(schema).count({where: {carePackageId: packageId, packageReservationStatus: 'RESERVED',
        ...(excludeEventId ? {id: {[Op.ne]: excludeEventId}} : {})}, transaction});
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
    if (!previousId && !targetId) {patch.carePackageId = null; patch.packageReservationStatus = null; return;}
    if (!canAccessAppointmentFinance(req, next, 'care_package', 'read')) fail('Non puoi gestire il pacchetto di questa seduta.', 403);
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
    if (target && (desired !== 'RELEASED' || targetId !== previousId)) {
        if (next.invoiceId) fail('La seduta è già fatturata.');
        const type = next.eventTypeId ? await EventType.schema(schema).findByPk(next.eventTypeId, {transaction}) : null;
        const error = packageCompatibilityError(target.get({plain: true}), next, type?.linkedServiceId ?? null);
        if (error) fail(error);
        if (desired === 'CONSUMED' && Date.parse(next.start ?? '') > Date.now()) fail('Una seduta futura non può essere segnata come effettuata.');
    }
    const wasConsumed = previous.packageReservationStatus === 'CONSUMED';
    const remainsConsumed = wasConsumed && previousId === targetId && desired === 'CONSUMED';
    if (wasConsumed && !remainsConsumed) {
        const original = await PackageConsumption.schema(schema).findOne({where: {packageId: previousId, agendaEventId: event.id,
            status: 'POSTED', type: 'CONSUME'}, transaction, lock: transaction.LOCK.UPDATE});
        if (!original) fail('Lo storico della seduta deve essere verificato prima della correzione.');
        const old = byId.get(previousId!);
        if (!old) fail('Pacchetto originale non disponibile.');
        await original!.update({status: 'REVERSED'}, {transaction});
        await PackageConsumption.schema(schema).create({packageId: previousId, agendaEventId: event.id, units: 1,
            type: 'REVERSE', reversalOfId: original!.get('id'), status: 'POSTED', createdByUserId: req.access?.userId,
            note: 'Ripristino per correzione dell’esito in agenda'}, {transaction});
        await old!.update({remainingUnits: Number(old!.get('remainingUnits')) + 1, status: 'ACTIVE'}, {transaction});
    }
    if (target && desired !== 'RELEASED' && !remainsConsumed) {
        const reserved = await reservedPackageUnits(schema, targetId!, transaction, event.id);
        if (Number(target.get('remainingUnits')) - reserved < 1) fail('Tutte le sedute del pacchetto sono già utilizzate o prenotate.');
        if (desired === 'CONSUMED') {
            await PackageConsumption.schema(schema).create({packageId: targetId, agendaEventId: event.id, units: 1,
                type: 'CONSUME', status: 'POSTED', createdByUserId: req.access?.userId, note: 'Seduta effettuata in agenda'}, {transaction});
            const remaining = Number(target.get('remainingUnits')) - 1;
            await target.update({remainingUnits: remaining, status: remaining === 0 ? 'EXHAUSTED' : 'ACTIVE'}, {transaction});
        }
    }
    patch.carePackageId = targetId;
    patch.packageReservationStatus = desired;
}

export async function eligibleCarePackages(schema: string, context: {patientId: string; structureId: string; eventTypeId: string; start: string; agendaEventId?: string}, transaction?: Transaction) {
    const type = await EventType.schema(schema).findByPk(context.eventTypeId, {transaction});
    if (!type?.linkedServiceId) return [];
    const packages = await CarePackage.schema(schema).findAll({where: {patientId: context.patientId, structureId: context.structureId,
        serviceId: type.linkedServiceId, templateId: {[Op.ne]: null}, status: {[Op.in]: ['ACTIVE', 'EXHAUSTED']}}, order: [['expiresAt', 'ASC'], ['createdAt', 'ASC']], transaction});
    const current = context.agendaEventId ? await AgendaEvent.schema(schema).findByPk(context.agendaEventId, {transaction}) : null;
    const result: Array<{id: string; name: string; serviceId: string; serviceName: string; purchasedUnits: number;
        remainingUnits: number; reservedUnits: number; availableUnits: number; expiresAt: string | null}> = [];
    for (const model of packages) {
        const pkg = model.get({plain: true});
        if (packageCompatibilityError(pkg, context, type.linkedServiceId)) continue;
        const reservedUnits = await reservedPackageUnits(schema, pkg.id, transaction, context.agendaEventId);
        const availableUnits = Number(pkg.remainingUnits) - reservedUnits
            + (current && current.carePackageId === pkg.id && current.packageReservationStatus === 'CONSUMED' ? 1 : 0);
        if (availableUnits > 0) result.push({id: pkg.id, name: pkg.name, serviceId: pkg.serviceId, serviceName: pkg.serviceName,
            purchasedUnits: Number(pkg.purchasedUnits), remainingUnits: Number(pkg.remainingUnits), reservedUnits, availableUnits, expiresAt: pkg.expiresAt});
    }
    return result;
}

export interface AppointmentPackageOptionsContext {
    patientId: string;
    structureId: string;
    calendarId: string;
    eventTypeId?: string;
    start?: string;
    agendaEventId?: string;
    recurring?: boolean;
    includeLegacy?: boolean;
    currentEvent?: Record<string, any>;
}
export interface AppointmentPackageOption {
    id: string; name: string; serviceId: string | null; serviceName: string | null;
    purchasedUnits: number; remainingUnits: number; reservedUnits: number; availableUnits: number;
    expiresAt: string | null; selectable: boolean; reason: string | null;
}

/** A contextual preview only. Saving still owns the locks and revalidates compatibility and capacity. */
export async function appointmentCarePackageOptions(schema: string, context: AppointmentPackageOptionsContext,
    transaction?: Transaction): Promise<AppointmentPackageOption[]> {
    const type = context.eventTypeId ? await EventType.schema(schema).findByPk(context.eventTypeId, {transaction}) : null;
    const models = await CarePackage.schema(schema).findAll({where: {patientId: context.patientId, structureId: context.structureId,
        ...(!context.includeLegacy ? {templateId: {[Op.ne]: null}} : {})},
        order: [['expiresAt', 'ASC'], ['createdAt', 'ASC'], ['id', 'ASC']], transaction});
    const packages = models.map(model => model.get({plain: true})).filter(pkg => pkg.patientId === context.patientId
        && pkg.structureId === context.structureId && (context.includeLegacy || !!pkg.templateId));
    const ids = packages.map(pkg => pkg.id);
    const reservations = ids.length ? await AgendaEvent.schema(schema).findAll({where: {
        carePackageId: {[Op.in]: ids}, packageReservationStatus: 'RESERVED',
        ...(context.agendaEventId ? {id: {[Op.ne]: context.agendaEventId}} : {})
    }, attributes: ['carePackageId'], transaction}) : [];
    const reservedByPackage = new Map<string, number>();
    reservations.forEach(model => {
        const id = String(model.get('carePackageId'));
        reservedByPackage.set(id, (reservedByPackage.get(id) ?? 0) + 1);
    });
    const current = context.currentEvent;
    const event = {...current, patientId: context.patientId, structureId: context.structureId, calendarId: context.calendarId,
        eventTypeId: context.eventTypeId, start: context.start,
        ...(context.recurring ? {recurrence: 'REQUESTED'} : {})};
    return packages.map(pkg => {
        const reservedUnits = reservedByPackage.get(pkg.id) ?? 0;
        const remainingUnits = Number(pkg.remainingUnits) || 0;
        const retainedConsumption = current?.id === context.agendaEventId && (current?.patientId ?? current?.patient?.id) === context.patientId
            && current?.structureId === context.structureId && current?.carePackageId === pkg.id
            && current?.packageReservationStatus === 'CONSUMED';
        const availableUnits = Math.max(0, remainingUnits - reservedUnits + (retainedConsumption ? 1 : 0));
        let reason = packageCompatibilityError(pkg, event, type?.linkedServiceId ?? null);
        if (!reason && current?.invoiceId) reason = 'La seduta è già fatturata.';
        if (!reason && current && String(current.status).toUpperCase() === 'COMPLETED' && current.carePackageId !== pkg.id) {
            reason = 'Riapri la seduta prima di assegnare o cambiare il pacchetto, poi segnala esplicitamente che è stata effettuata.';
        }
        if (!reason && availableUnits < 1) reason = remainingUnits <= 0
            ? 'Non restano sedute da utilizzare in questo pacchetto.' : 'Le sedute residue sono già tutte prenotate.';
        return {id: String(pkg.id), name: String(pkg.name ?? 'Pacchetto'), serviceId: pkg.serviceId ?? null,
            serviceName: pkg.serviceName ?? null, purchasedUnits: Number(pkg.purchasedUnits) || 0,
            remainingUnits, reservedUnits, availableUnits, expiresAt: pkg.expiresAt ? String(pkg.expiresAt).slice(0, 10) : null,
            selectable: !reason, reason};
    }).sort((left, right) => Number(right.selectable) - Number(left.selectable));
}

import {Request} from 'express';
import {Op, Transaction} from 'sequelize';
import {getUserId} from '../../../middleware/rbac.js';
import Patient from '../../patients/models/patient.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import Service from '../../products-services/models/service.model.js';
import ServiceStructure from '../../products-services/models/serviceStructure.model.js';
import {availabilityWhere} from '../../products-services/services/structureAvailability.service.js';
import {canAccessAppointmentFinance} from '../../agenda/services/appointmentFinancialAccess.service.js';
import {Quote} from '../models/index.js';
import {quoteScopeWhere} from './quoteAccess.js';
import {packageBookingState, PackageBookingState} from './packageBooking.service.js';
import {CarePackageOrigin, carePackageOrigin, packageAccessRequest, packageMoneySummary, packagePatientIdentityWhere, packageToday} from './carePackage.service.js';

type Plain = Record<string, any>;
export type PackageBookingRead = Omit<PackageBookingState, 'services'> & {
    services: Array<PackageBookingState['services'][number] & {reservedUnits: number; availableUnits: number}>;
    availableServices?: Array<{id: string; name: string}>;
};
export interface CarePackageReadView extends Plain {
    id: string; patientId: string; structureId: string; name: string; status: string;
    quoteId: string | null; templateId: string | null; origin: CarePackageOrigin;
    quoteNumber: string | null; canOpenQuote: boolean; canOpen: boolean;
    purchasedUnits: number; remainingUnits: number; reservedUnits: number; availableUnits: number;
    totalPrice: number | null; paidAmount: number | null; balance: number | null; paymentStatus: string | null;
    expiresAt: string | null; serviceId: string | null; serviceName: string | null;
    booking: PackageBookingRead; canBook: boolean; canConfigureBooking: boolean; includedInSummary: boolean;
}

/** Read projection only: no list/detail request activates or repairs a historical package. */
export async function decorateCarePackages(req: Request, rows: Plain[], options: {transaction?: Transaction; patientNames?: boolean; setupOptions?: boolean} = {}): Promise<CarePackageReadView[]> {
    if (!rows.length) return [];
    const schema = req.tenantSchema!, transaction = options.transaction, today = packageToday();
    const ids = rows.map(row => row.id), patientIds = [...new Set(rows.map(row => row.patientId))];
    const quoteIds = [...new Set(rows.map(row => row.quoteId).filter(Boolean))];
    const loadQuotes = async (): Promise<Plain[]> => {
        if (!quoteIds.length) return [];
        let scoped: Request;
        try {scoped = packageAccessRequest(req, 'quote', 'read');}
        catch (error) {if ((error as {statusCode?: number}).statusCode === 403) return []; throw error;}
        return (await Quote.schema(schema).findAll({where: {[Op.and]: [{id: {[Op.in]: quoteIds}}, quoteScopeWhere(scoped)]},
            attributes: ['id', 'patientId', 'structureId', 'number', 'year', 'total'], transaction})).map(model => model.get({plain: true}) as Plain);
    };
    const loadConfigurablePatients = async (): Promise<Set<string>> => {
        if (!rows.some(row => !row.templateId && packageBookingState(row).status === 'NEEDS_SETUP')) return new Set();
        let where: Plain;
        try {where = packagePatientIdentityWhere(req, 'quote', 'update');}
        catch (error) {if ((error as {statusCode?: number}).statusCode === 403) return new Set(); throw error;}
        return new Set((await Patient.schema(schema).findAll({where: {[Op.and]: [{id: {[Op.in]: patientIds}}, where]}, attributes: ['id'], transaction}))
            .map(model => String(model.get('id'))));
    };
    // A transaction owns one connection; avoid independent queries after an earlier query failed.
    const payments = await InvoicePayment.schema(schema).findAll({where: {carePackageId: {[Op.in]: ids}}, transaction});
    const reservations = await AgendaEvent.schema(schema).findAll({where: {carePackageId: {[Op.in]: ids}, packageReservationStatus: 'RESERVED'},
        attributes: ['id', 'carePackageId', 'carePackageServiceId'], transaction});
    const patients = options.patientNames === false ? [] : await Patient.schema(schema).findAll({where: {id: {[Op.in]: patientIds}}, attributes: ['id', 'name', 'surname'], transaction});
    const quotes = await loadQuotes(), configurablePatients = await loadConfigurablePatients();
    let availableServices: Array<{id: string; name: string}> | undefined;
    if (options.setupOptions && configurablePatients.size) {
        const structureId = rows[0].structureId;
        availableServices = (await Service.schema(schema).findAll({where: {[Op.and]: [{isActive: true},
            await availabilityWhere(ServiceStructure, schema, 'serviceId', structureId)]}, attributes: ['id', 'name'], order: [['name', 'ASC'], ['id', 'ASC']], transaction}))
            .map(model => ({id: String(model.get('id')), name: String(model.get('name'))}));
    }
    return rows.map(row => {
        const state = packageBookingState(row), packageReservations = reservations.filter(model => model.get('carePackageId') === row.id);
        const remainingUnits = Math.max(0, Number(row.remainingUnits) || 0), reservedUnits = packageReservations.length;
        const expiresAt = row.expiresAt ? String(row.expiresAt).slice(0, 10) : null;
        const expired = row.status === 'ACTIVE' && !!expiresAt && expiresAt < today;
        const includedInSummary = row.status === 'ACTIVE' && remainingUnits > 0 && !expired;
        const validToday = includedInSummary && (!row.purchasedAt || String(row.purchasedAt).slice(0, 10) <= today);
        const usableServices = state.status === 'READY' ? state.services : [];
        let unallocatedReservations = 0;
        const byService = new Map<string, number>();
        for (const reservation of packageReservations) {
            const serviceId = reservation.get('carePackageServiceId') || (usableServices.length === 1 ? usableServices[0].serviceId : null);
            if (!serviceId || !usableServices.some(service => service.serviceId === serviceId)) unallocatedReservations++;
            else byService.set(String(serviceId), (byService.get(String(serviceId)) ?? 0) + 1);
        }
        const globalAvailableUnits = Math.max(0, remainingUnits - reservedUnits);
        const services = usableServices.map(service => {
            const reserved = (byService.get(service.serviceId) ?? 0) + unallocatedReservations;
            return {...service, reservedUnits: reserved, availableUnits: validToday ? Math.max(0, Math.min(globalAvailableUnits, service.remainingUnits - reserved)) : 0};
        });
        const availableUnits = validToday ? Math.min(globalAvailableUnits, services.reduce((sum, service) => sum + service.availableUnits, 0)) : 0;
        const canConfigureBooking = !row.templateId && state.status === 'NEEDS_SETUP' && remainingUnits > 0
            && ['ACTIVE', 'EXHAUSTED'].includes(row.status) && configurablePatients.has(String(row.patientId));
        const booking: PackageBookingRead = {...state, services, ...(canConfigureBooking && availableServices ? {availableServices} : {})};
        const quote = quotes.find(quote => quote.id === row.quoteId && quote.patientId === row.patientId && quote.structureId === row.structureId);
        const rawPrice = row.totalPrice == null || row.totalPrice === '' ? null : Number(row.totalPrice);
        const documentedZero = quote?.total != null && quote.total !== '' && Number(quote.total) === 0;
        const totalPrice = rawPrice !== null && Number.isFinite(rawPrice) && rawPrice >= 0 && (rawPrice > 0 || !!row.templateId || documentedZero) ? rawPrice : null;
        const money = row.templateId && totalPrice !== null ? packageMoneySummary({...row, totalPrice}, payments.filter(payment => payment.get('carePackageId') === row.id)
            .map(model => model.get({plain: true}))) : {paidAmount: null, balance: null, paymentStatus: null};
        const patient = patients.find(patient => patient.get('id') === row.patientId);
        return {...row, id: String(row.id), patientId: String(row.patientId), structureId: String(row.structureId), name: String(row.name),
            origin: carePackageOrigin(row), quoteId: row.quoteId ?? null, templateId: row.templateId ?? null,
            quoteNumber: quote && quote.number != null && quote.year != null ? `PRV-${quote.year}/${String(quote.number).padStart(4, '0')}` : null,
            canOpenQuote: !!quote, legacy: !row.templateId, canOpen: true, status: expired ? 'EXPIRED' : row.status,
            patientName: patient ? [patient.get('name'), patient.get('surname')].filter(Boolean).join(' ') : row.patientName ?? null,
            purchasedUnits: Number(row.purchasedUnits) || 0, remainingUnits, reservedUnits, availableUnits, totalPrice, ...money, expiresAt,
            serviceId: row.serviceId ?? null, serviceName: row.serviceName ?? null, includedInSummary, booking, canConfigureBooking,
            canBook: availableUnits > 0 && canAccessAppointmentFinance(req, {structureId: row.structureId, calendarId: getUserId(req)}, 'agenda', 'create')};
    });
}

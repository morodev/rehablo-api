import {Request} from 'express';
import {Op} from 'sequelize';
import {getGrantedPermissions, getSelectedStructureId, getUserId, patientScopeWhere} from '../../../middleware/rbac.js';
import {resolveGrantedScope} from '../../auth/rbac/permissions.js';
import {CarePackage, PackageConsumption} from '../../administration/models/index.js';
import {isFinancialCarePackage, packageMoneySummary, packageOriginReadWhere} from '../../administration/services/carePackage.service.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import {summarizeInvoicePayments} from '../../invoice/services/payment.service.js';
import Patient from '../../patients/models/patient.model.js';
import {validIssuedDocument} from './financialFacts.service.js';

type Row = Record<string, any>;
export interface ReportPackageSummary {
    id: string;
    name: string;
    paymentStatus: 'paid' | 'partial' | 'unpaid' | 'unknown';
    invoiceId: string | null;
    invoiceStatus: 'issued' | 'void' | 'none' | 'unknown';
    canOpen: boolean;
}
export interface ReportPackageCoverage {
    carePackageId: string | null;
    packageReservationStatus: 'RESERVED' | 'CONSUMED';
    packageSessionValue: number | null;
    packageValueUnavailableReason?: string;
    packageSummary: ReportPackageSummary | null;
    paymentMethods: string[];
}
export interface PackageCoverageEvidence {
    packages: Row[];
    consumptions: Row[];
    payments: Row[];
    invoices?: Row[];
    purchaseInvoices?: Row[];
    invoiceReadablePatients?: Set<string>;
    openablePackageIds?: Set<string>;
    legacyPayments?: Row[];
}
const plain = (row: any): Row => typeof row.get === 'function' ? row.get({plain: true}) : row;
const identity = (row: Row) => `${row.patientId ?? row.patient?.id ?? ''}:${row.structureId ?? ''}`;
const invoiceIdentity = (row: Row) => `${row.patientID ?? ''}:${row.structureId ?? ''}`;
const methodKey = (value: unknown) => {
    const method = String(value ?? '').trim();
    return !method || method.toLowerCase() === 'dashboard' ? '__unspecified__' : method;
};
const units = (value: unknown): number | null => {
    const number = Number(value);
    return value != null && value !== '' && Number.isSafeInteger(number) && number > 0 ? number : null;
};
const cents = (value: unknown): number | null => {
    if (value == null || value === '') return null;
    const number = Number(value), result = Math.round(number * 100);
    return Number.isFinite(number) && number >= 0 && Number.isSafeInteger(result)
        && Math.abs(number * 100 - result) < 1e-6 ? result : null;
};
const valueMissing = (reason: string): {value: null; reason: string} => ({value: null, reason});
const identifier = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const activeEvent = (event: Row) => !['CANCELLED', 'NO_SHOW'].includes(String(event.status ?? '').toUpperCase());
const assigned = (event: Row) => activeEvent(event) && !!event.carePackageId && ['RESERVED', 'CONSUMED'].includes(event.packageReservationStatus);

/** Contract averages only: live tariffs, invoice stamp duty and non-service quote lines are never allocated to sessions. */
export function packageSessionValue(pack: Row, requestedServiceId: string | null): {value: number | null; reason?: string} {
    const purchased = units(pack.purchasedUnits), total = cents(pack.totalPrice);
    if (pack.templateId) {
        if (!purchased || total === null) return valueMissing('Prezzo o quantità del pacchetto non disponibili.');
        if (requestedServiceId && pack.serviceId && requestedServiceId !== pack.serviceId) return valueMissing('La prestazione non corrisponde al contratto del pacchetto.');
        return {value: Math.round(total / purchased) / 100};
    }
    const lines: Row[] = Array.isArray(pack.lines) ? pack.lines : [];
    const serviceLines = lines.map((line, index) => ({line, key: identifier(line.id) ?? `line-${index}`}))
        .filter(({line}) => line.itemType === 'SERVICE');
    if (!purchased || !serviceLines.length) return valueMissing('Le condizioni economiche delle prestazioni non sono disponibili.');
    if (serviceLines.some(({line}) => units(line.quantity) === null) || serviceLines.reduce((sum, {line}) => sum + Number(line.quantity), 0) !== purchased) {
        return valueMissing('Le quantità delle prestazioni non corrispondono al contratto del pacchetto.');
    }
    const allTotals = lines.map(line => cents(line.total));
    if (total !== null && allTotals.every(value => value !== null) && allTotals.reduce<number>((sum, value) => sum + (value ?? 0), 0) !== total) {
        return valueMissing('I totali delle righe non corrispondono al contratto del pacchetto.');
    }
    const booking = pack.purchaseSnapshot?.booking;
    const mappings: Row[] = Array.isArray(booking?.mappings) ? booking.mappings : [];
    const bookingServices: Row[] = Array.isArray(booking?.services) ? booking.services : [];
    const fallback = bookingServices.length === 1 ? identifier(bookingServices[0].serviceId) : identifier(pack.serviceId);
    const grouped = new Map<string, {quantity: number; total: number | null}>();
    const keys = new Set<string>();
    for (const {line, key} of serviceLines) {
        if (keys.has(key)) return valueMissing('Le righe del contratto non sono identificabili in modo univoco.');
        keys.add(key);
        const mapped = mappings.filter(mapping => mapping.lineId === key);
        if (mapped.length > 1) return valueMissing('La prestazione della seduta non è identificabile in modo univoco.');
        const serviceId = mapped.length ? identifier(mapped[0].serviceId) : identifier(line.itemId) ?? fallback;
        if (!serviceId) return valueMissing('Collega le prestazioni del contratto per determinarne il valore.');
        const before = grouped.get(serviceId), amount = cents(line.total);
        grouped.set(serviceId, {quantity: (before?.quantity ?? 0) + Number(line.quantity),
            total: amount === null || before?.total === null ? null : (before?.total ?? 0) + amount});
    }
    const serviceId = requestedServiceId ?? (grouped.size === 1 ? [...grouped.keys()][0] : null);
    const group = serviceId ? grouped.get(serviceId) : null;
    if (!group) return valueMissing('La prestazione della seduta non è identificabile nel contratto.');
    const agreed = bookingServices.find(service => service.serviceId === serviceId);
    if (agreed && units(agreed.purchasedUnits) !== group.quantity) return valueMissing('Le quantità della prestazione non corrispondono al contratto.');
    if (group.total === null) return valueMissing('Il prezzo concordato della prestazione non è disponibile.');
    return {value: Math.round(group.total / group.quantity) / 100};
}

export function unknownPackageCoverage(packageId: string | null, status: 'RESERVED' | 'CONSUMED', reason = 'Il pacchetto della seduta non è disponibile.'): ReportPackageCoverage {
    return {carePackageId: packageId, packageReservationStatus: status, packageSessionValue: null, packageValueUnavailableReason: reason,
        packageSummary: packageId ? {id: packageId, name: 'Pacchetto', paymentStatus: 'unknown', invoiceId: null, invoiceStatus: 'unknown', canOpen: false} : null,
        paymentMethods: []};
}

/** A pure projection; extra purchase evidence never enters the cash ledger used by the report. */
export function projectPackageCoverage(events: Row[], evidence: PackageCoverageEvidence): Map<string, ReportPackageCoverage> {
    const result = new Map<string, ReportPackageCoverage>();
    const consumptions = evidence.consumptions.filter(row => row.status === 'POSTED' && row.type === 'CONSUME' && units(row.units) !== null);
    for (const event of events) {
        if (!activeEvent(event) || event.packageReservationStatus === 'RELEASED') continue;
        const modern = assigned(event), traces = consumptions.filter(row => row.agendaEventId === event.id);
        const coveragePayment = evidence.legacyPayments?.some(row => row.agendaEventId === event.id && row.source === 'PACKAGE' && row.status === 'POSTED');
        if (!modern && !traces.length && !coveragePayment) continue;
        if (!modern && traces.length !== 1) {
            result.set(event.id, unknownPackageCoverage(null, 'CONSUMED', 'Il consumo storico non identifica un unico pacchetto verificabile.'));
            continue;
        }
        const trace = modern ? null : traces[0];
        const packageId = modern ? event.carePackageId : trace!.packageId;
        const status = modern ? event.packageReservationStatus as 'RESERVED' | 'CONSUMED' : 'CONSUMED';
        const pack = evidence.packages.find(row => row.id === packageId && identity(row) === identity(event));
        if (!pack) {result.set(event.id, unknownPackageCoverage(packageId, status)); continue;}
        if (trace && Number(trace.units) !== 1) {
            result.set(event.id, unknownPackageCoverage(packageId, status, 'Il consumo storico non corrisponde a una singola seduta.'));
            continue;
        }
        const purchaseInvoice = (evidence.purchaseInvoices ?? evidence.invoices)?.find(row => row.id === pack.invoiceId && invoiceIdentity(row) === identity(pack)
            && (!row.carePackageId || row.carePackageId === pack.id));
        const payments = [...new Map(evidence.payments.filter(row => (row.carePackageId === packageId
            || purchaseInvoice && row.invoiceId === purchaseInvoice.id && (!row.carePackageId || row.carePackageId === packageId))
            && !['PACKAGE', 'CREDIT', 'OPENING_BALANCE'].includes(row.source)).map(row => [row.id, row])).values()];
        const price = packageSessionValue(pack, identifier(event.carePackageServiceId) ?? identifier(trace?.serviceId));
        const validPayments = payments.every(payment => payment.status !== 'POSTED' || cents(payment.amount) !== null);
        const documentedZero = !!pack.quoteId && Array.isArray(pack.lines) && pack.lines.length > 0 && pack.lines.every((line: Row) => cents(line.total) === 0);
        const moneyKnown = cents(pack.totalPrice) !== null && validPayments && (isFinancialCarePackage(pack) || payments.some(payment => payment.status === 'POSTED') || documentedZero);
        const invoiceSummary = purchaseInvoice && validIssuedDocument(purchaseInvoice) && cents(purchaseInvoice.invoiceNet ?? purchaseInvoice.invoiceTotal) !== null && validPayments
            ? summarizeInvoicePayments(purchaseInvoice, payments) : null;
        const paymentStatus: ReportPackageSummary['paymentStatus'] = invoiceSummary && ['paid', 'partial', 'unpaid'].includes(invoiceSummary.paymentStatus)
            ? invoiceSummary.paymentStatus as ReportPackageSummary['paymentStatus']
            : moneyKnown ? packageMoneySummary(pack, payments).paymentStatus as ReportPackageSummary['paymentStatus'] : 'unknown';
        const canInspectInvoice = evidence.invoiceReadablePatients?.has(identity(pack)) ?? false;
        const invoice = canInspectInvoice && pack.invoiceId ? evidence.invoices?.find(row => row.id === pack.invoiceId && invoiceIdentity(row) === identity(pack)
            && (!row.carePackageId || row.carePackageId === pack.id)) : null;
        const invoiceStatus: ReportPackageSummary['invoiceStatus'] = !canInspectInvoice ? 'unknown' : !pack.invoiceId ? 'none' : !invoice ? 'unknown'
            : ['void', 'cancelled'].includes(String(invoice.status).toLowerCase()) ? 'void' : validIssuedDocument(invoice) ? 'issued' : 'unknown';
        result.set(event.id, {carePackageId: packageId, packageReservationStatus: status, packageSessionValue: price.value,
            ...(price.reason ? {packageValueUnavailableReason: price.reason} : {}),
            packageSummary: {id: packageId, name: String(pack.name || 'Pacchetto'), paymentStatus,
                invoiceId: invoice?.id ?? null, invoiceStatus, canOpen: evidence.openablePackageIds?.has(packageId) ?? false},
            paymentMethods: [...new Set(payments.filter(row => row.status === 'POSTED').map(row => methodKey(row.method)))]});
    }
    return result;
}

/** Batch enrichment for the selected therapies only. It deliberately does not extend FinanceData.packages/payments or cash facts. */
export async function loadPackageCoverage(req: Request, events: Row[], legacyPayments: Row[] = []): Promise<Map<string, ReportPackageCoverage>> {
    if (!events.length) return new Map();
    const schema = req.tenantSchema!;
    const legacyIds = events.filter(event => activeEvent(event) && event.packageReservationStatus !== 'RELEASED' && !assigned(event)).map(event => event.id);
    const consumptions = legacyIds.length ? (await PackageConsumption.schema(schema).findAll({where: {agendaEventId: {[Op.in]: legacyIds}, type: 'CONSUME', status: 'POSTED'},
        attributes: ['id', 'packageId', 'agendaEventId', 'serviceId', 'units', 'status', 'type']})).map(plain) : [];
    const references = events.flatMap(event => {
        const traces = consumptions.filter(row => row.agendaEventId === event.id && row.status === 'POSTED' && row.type === 'CONSUME');
        const packageId = assigned(event) ? event.carePackageId : traces.length === 1 ? traces[0].packageId : null;
        const patientId = event.patientId ?? event.patient?.id;
        return packageId && patientId && event.structureId ? [{id: packageId, patientId, structureId: event.structureId}] : [];
    });
    if (!references.length) return projectPackageCoverage(events, {packages: [], consumptions, payments: [], legacyPayments});
    const packages = (await CarePackage.schema(schema).findAll({where: {[Op.or]: references},
        attributes: ['id', 'patientId', 'structureId', 'name', 'templateId', 'quoteId', 'serviceId', 'purchasedUnits', 'totalPrice', 'lines', 'purchaseSnapshot', 'invoiceId']})).map(plain)
        .filter(pack => references.some(reference => reference.id === pack.id && identity(reference) === identity(pack)));
    const ids = packages.map(pack => pack.id);
    const invoiceReferences = packages.filter(pack => pack.invoiceId).map(pack => ({id: pack.invoiceId, patientID: pack.patientId,
        structureId: pack.structureId, [Op.or]: [{carePackageId: pack.id}, {carePackageId: null}]}));
    const purchaseInvoices = invoiceReferences.length ? (await Invoice.schema(schema).findAll({where: {[Op.or]: invoiceReferences},
        attributes: ['id', 'patientID', 'structureId', 'carePackageId', 'status', 'emissionDate', 'documentType', 'invoiceTotal', 'invoiceNet']})).map(plain)
        .filter(invoice => packages.some(pack => invoice.id === pack.invoiceId && invoiceIdentity(invoice) === identity(pack)
            && (!invoice.carePackageId || invoice.carePackageId === pack.id))) : [];
    const invoiceIds = purchaseInvoices.map(invoice => invoice.id);
    const payments = ids.length ? (await InvoicePayment.schema(schema).findAll({where: {[Op.or]: [
        {carePackageId: {[Op.in]: ids}}, ...(invoiceIds.length ? [{invoiceId: {[Op.in]: invoiceIds}}] : [])]},
        attributes: ['id', 'carePackageId', 'invoiceId', 'amount', 'method', 'source', 'status']})).map(plain) : [];
    let openablePackageIds = new Set<string>();
    if (ids.length) {
        let where: Record<string | symbol, any> | null = null;
        try {where = packageOriginReadWhere(req);}
        catch (failure) {if (![403, 409].includes((failure as {statusCode?: number}).statusCode ?? 0)) throw failure;}
        if (where) openablePackageIds = new Set((await CarePackage.schema(schema).findAll({where: {[Op.and]: [{id: {[Op.in]: ids}}, where]}, attributes: ['id']})).map(row => String(row.get('id'))));
    }
    const granted = req.user?.isSuperAdmin ? 'tenant' : resolveGrantedScope(getGrantedPermissions(req), 'invoice', 'read');
    let invoiceReadablePatients = new Set<string>();
    let invoices: Row[] = [];
    if (granted && packages.length) {
        const invoiceRequest = Object.assign(Object.create(req), {access: {resource: 'invoice', action: 'read', scope: granted, userId: getUserId(req), structureId: getSelectedStructureId(req)}}) as Request;
        const patients = (await Patient.schema(schema).findAll({where: {[Op.and]: [
            {id: {[Op.in]: [...new Set(packages.map(pack => pack.patientId))]}}, patientScopeWhere(invoiceRequest, schema, 'id')
        ]}, attributes: ['id', 'structureId']})).map(plain);
        invoiceReadablePatients = new Set(patients.map(patient => `${patient.id}:${patient.structureId}`));
        invoices = purchaseInvoices.filter(invoice => invoiceReadablePatients.has(invoiceIdentity(invoice)));
    }
    return projectPackageCoverage(events, {packages, consumptions, payments, invoices, purchaseInvoices, invoiceReadablePatients, openablePackageIds, legacyPayments});
}

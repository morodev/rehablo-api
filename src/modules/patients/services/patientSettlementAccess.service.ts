import {Request} from 'express';
import {Op, Transaction} from 'sequelize';
import {getGrantedPermissions, getSelectedStructureId, getUserId} from '../../../middleware/rbac.js';
import {getCurrentTenantId} from '../../../middleware/auth.js';
import {Action, Resource, resolveGrantedScope} from '../../auth/rbac/permissions.js';
import {Structure, Tenant, User} from '../../auth/models/index.js';
import Patient from '../models/patient.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoiceAgendaEvent from '../../invoice/models/invoiceAgendaEvent.model.js';
import {CarePackage, PatientCredit, TreasuryMovement} from '../../administration/models/index.js';
import {PatientSettlementContext, PatientSettlementObligation, RawPatientSettlementPosition,
    loadPatientSettlementPosition, settlementFail, settlementPatientId} from './patientSettlementPolicy.service.js';
import {paymentMoney} from '../../invoice/services/appointmentPayment.service.js';

export const SETTLEMENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface AuthorizedSettlementContext extends PatientSettlementContext {
    patient: Record<string, any>;
}
export interface SettlementObligationView {
    key: string; kind: 'APPOINTMENT' | 'INVOICE'; targetId: string; title: string;
    date: string | null; orderDate: string; balance: number | null; expectedAmount: number | null; paidAmount: number;
    isCurrent: boolean; invoiceNumber: string | null; linkedEventIds: string[]; canCash: boolean; canUseCredit: boolean;
}
export interface SettlementPositionView {
    patientId: string; structureId: string;
    reference: {
        agendaEventId: string | null; invoiceId: string | null; currentObligationKey: string | null;
        currentEligible: boolean; unavailableReason: string | null;
        summary: {expectedAmount: number | null; paidAmount: number; balance: number | null; paymentStatus: string;
            coverageSources: string[]; methods: Array<string | null>; hasUndatedPayments: boolean};
        pricing: {originalAmount: number | null; adjustment: 'DISCOUNT' | 'COMPLIMENTARY' | null; note: string | null; editable: boolean} | null;
    };
    obligations: SettlementObligationView[];
    verification: Array<{agendaEventId: string; date: string | null; start: string | null; calendarId: string | null;
        operatorName: string | null; title: string; reason: 'UNVERIFIED_HISTORY' | 'NO_SHOW'}>;
    totals: {knownOutstandingAmount: number; priorKnownOutstandingAmount: number; unknownPriceCount: number; priorUnknownPriceCount: number; priorCount: number};
    blocker: {kind: 'INACCESSIBLE_PRIOR' | 'READ_ONLY'; message: string} | null;
    capabilities: {cash: boolean; credit: boolean; packages: boolean};
    creditsSummary: {verifiedRemaining: number; unverifiedCount: number} | null;
    packagesSummary: {activeCount: number; remainingUnits: number} | null;
}

export function settlementScope(req: Request, resource: Resource, action: Action) {
    return req.user?.isSuperAdmin ? 'tenant' as const : resolveGrantedScope(getGrantedPermissions(req), resource, action);
}

/** Invoice visibility follows the existing patient-derived scope; agenda ownership follows calendarId. */
export function settlementRecordAccess(req: Request, context: AuthorizedSettlementContext,
    kind: 'APPOINTMENT' | 'INVOICE' | 'CREDIT', record: Record<string, any>, action: Action): boolean {
    const scope = settlementScope(req, kind === 'APPOINTMENT' ? 'agenda' : kind === 'INVOICE' ? 'invoice' : 'quote', action);
    if (!scope) return false;
    if (scope === 'tenant') return true;
    if (scope === 'own') return kind === 'APPOINTMENT' ? record.calendarId === getUserId(req) : context.patient.userId === getUserId(req);
    const selected = getSelectedStructureId(req);
    if (!selected) return false;
    if (kind === 'INVOICE') return context.patient.structureId === selected;
    return (record.structureId ?? context.structureId) === selected;
}

export async function resolvePatientSettlementContext(req: Request, source: Record<string, any>,
    transaction?: Transaction): Promise<AuthorizedSettlementContext> {
    const patientId = req.params.patientId;
    if (!SETTLEMENT_UUID.test(patientId)) settlementFail(400, 'Paziente non valido');
    const optionalId = (name: string): string | undefined => {
        const value = source[name];
        if (value == null || value === '') return undefined;
        if (typeof value !== 'string' || !SETTLEMENT_UUID.test(value)) settlementFail(400, 'Contesto dell’operazione non valido');
        return value;
    };
    const referenceAgendaEventId = optionalId('referenceAgendaEventId');
    let referenceInvoiceId = optionalId('referenceInvoiceId');
    const requestedStructureId = optionalId('structureId');
    const patientModel = await Patient.schema(req.tenantSchema!).findByPk(patientId, {transaction});
    if (!patientModel) settlementFail(404, 'Paziente non trovato o non accessibile');
    const patient = patientModel!.get({plain: true}) as Record<string, any>;
    const eventModel = referenceAgendaEventId ? await AgendaEvent.schema(req.tenantSchema!).findByPk(referenceAgendaEventId, {transaction}) : null;
    const event = eventModel?.get({plain: true}) as Record<string, any> | undefined;
    const explicitInvoiceReference = !!referenceInvoiceId;
    if (event && !referenceInvoiceId) {
        referenceInvoiceId = event.invoiceId ?? undefined;
        if (!referenceInvoiceId) {
            const link = await InvoiceAgendaEvent.schema(req.tenantSchema!).findOne({where: {agendaEventId: event.id, releasedAt: null}, transaction});
            referenceInvoiceId = link?.get('invoiceId') as string | undefined;
        }
    }
    const invoiceModel = referenceInvoiceId ? await Invoice.schema(req.tenantSchema!).findByPk(referenceInvoiceId, {transaction}) : null;
    const invoice = invoiceModel?.get({plain: true}) as Record<string, any> | undefined;
    if (event && explicitInvoiceReference) {
        const activeLink = event.invoiceId ? null : await InvoiceAgendaEvent.schema(req.tenantSchema!).findOne({
            where: {agendaEventId: event.id, releasedAt: null}, transaction});
        if ((event.invoiceId ?? activeLink?.get('invoiceId')) !== referenceInvoiceId) settlementFail(409, 'I riferimenti non descrivono lo stesso appuntamento');
    }
    if (referenceAgendaEventId && (!event || settlementPatientId(event) !== patientId)) settlementFail(404, 'Appuntamento non trovato o non accessibile');
    if (referenceInvoiceId && (!invoice || invoice.patientID !== patientId)) settlementFail(404, 'Fattura non trovata o non accessibile');
    let legacyInvoiceSite: string | undefined;
    if (invoice && invoice.structureId == null) {
        const links = await InvoiceAgendaEvent.schema(req.tenantSchema!).findAll({where: {invoiceId: invoice.id, releasedAt: null}, transaction});
        const ids = [...new Set([...links.map(link => String(link.get('agendaEventId'))), invoice.agendaEventId].filter(Boolean))];
        const linkedEvents = await AgendaEvent.schema(req.tenantSchema!).findAll({where: {[Op.and]: [
            {[Op.or]: [{patientId}, {patient: {id: patientId} as any}]},
            {[Op.or]: [{invoiceId: invoice.id}, ...(ids.length ? [{id: {[Op.in]: ids}}] : [])]}
        ]}, transaction});
        const sites = [...new Set(linkedEvents.map(row => row.get('structureId')).filter(Boolean))] as string[];
        if (sites.length > 1) settlementFail(409, 'La sede della fattura storica non è univoca: verifica i collegamenti');
        legacyInvoiceSite = sites[0];
    }
    const invoiceSite = invoice?.structureId ?? legacyInvoiceSite;
    const authoritativeSite = event?.structureId ?? invoiceSite;
    if (event?.structureId && invoiceSite && event.structureId !== invoiceSite) settlementFail(409, 'I riferimenti appartengono a sedi diverse');
    if (requestedStructureId && authoritativeSite && requestedStructureId !== authoritativeSite) settlementFail(409, 'La sede non corrisponde al riferimento dell’operazione');
    const structureId = authoritativeSite ?? requestedStructureId ?? getSelectedStructureId(req) ?? patient.structureId;
    if (!structureId || !SETTLEMENT_UUID.test(structureId)) settlementFail(409, 'Seleziona una sede valida per la gestione economica');
    if (!await Structure.findOne({where: {id: structureId, tenantId: getCurrentTenantId(req)}, transaction})) settlementFail(404, 'Sede non disponibile');
    const context: AuthorizedSettlementContext = {patientId, structureId, patient, referenceAgendaEventId, referenceInvoiceId};
    if (source.referenceOccurrenceStart != null) {
        const occurrence = source.referenceOccurrenceStart;
        if (!event?.recurrence || typeof occurrence !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(occurrence)
            || !Number.isFinite(Date.parse(occurrence))) settlementFail(400, 'Data dell’occorrenza non valida');
        context.referenceOccurrenceStart = new Date(occurrence).toISOString();
    }
    if (event && !settlementRecordAccess(req, context, 'APPOINTMENT', event, 'read')) settlementFail(404, 'Appuntamento non trovato o non accessibile');
    if (explicitInvoiceReference && invoice && !settlementRecordAccess(req, context, 'INVOICE', invoice, 'read')) settlementFail(404, 'Fattura non trovata o non accessibile');
    if (!event && !invoice) {
        const agendaScope = settlementScope(req, 'agenda', 'read');
        const invoiceAccess = settlementRecordAccess(req, context, 'INVOICE', {}, 'read');
        const agendaAccess = agendaScope === 'tenant' || (agendaScope === 'structure' && getSelectedStructureId(req) === structureId
            && patient.structureId === structureId) || (agendaScope === 'own' && patient.userId === getUserId(req));
        if (!agendaAccess && !invoiceAccess) settlementFail(404, 'Paziente non trovato o non accessibile');
    }
    return context;
}

export async function settlementAdministrationEnabled(req: Request, transaction?: Transaction): Promise<boolean> {
    const tenant = await Tenant.findByPk(getCurrentTenantId(req), {attributes: ['featureFlags'], transaction});
    return (tenant?.get('featureFlags') as {administration?: boolean} | undefined)?.administration === true;
}

export async function verifiedSettlementCredit(schema: string, credit: Record<string, any>, transaction?: Transaction): Promise<boolean> {
    if (!credit.sourceId || !['TREASURY_ADVANCE', 'VOID_CREDIT'].includes(credit.sourceType)) return false;
    const receiptModel = credit.sourceType === 'TREASURY_ADVANCE'
        ? await TreasuryMovement.schema(schema).findByPk(credit.sourceId, {transaction})
        : await TreasuryMovement.schema(schema).findOne({where: {sourceType: 'INVOICE_PAYMENT', sourceId: credit.sourceId}, transaction});
    if (!receiptModel) return false;
    const receipt = receiptModel.get({plain: true});
    if (receipt.status !== 'POSTED' || receipt.direction !== 'IN' || receipt.structureId !== credit.structureId
        || Number(receipt.amount) < Number(credit.amount)
        || (credit.sourceType === 'TREASURY_ADVANCE' && (receipt.sourceType !== 'PATIENT_ADVANCE' || receipt.sourceId !== credit.id))) return false;
    return await TreasuryMovement.schema(schema).count({where: {reversalOfId: receipt.id, status: 'POSTED'}, transaction}) === 0;
}

export function settlementCanRead(req: Request, context: AuthorizedSettlementContext, row: PatientSettlementObligation): boolean {
    return settlementRecordAccess(req, context, row.kind, row.record, 'read');
}
export function settlementCanCash(req: Request, context: AuthorizedSettlementContext, row: PatientSettlementObligation): boolean {
    return row.eligible && settlementCanRead(req, context, row) && settlementRecordAccess(req, context, row.kind, row.record, 'update');
}
export function settlementCanUseCredit(req: Request, context: AuthorizedSettlementContext,
    row: PatientSettlementObligation, administrationEnabled: boolean): boolean {
    return administrationEnabled && row.eligible && settlementCanRead(req, context, row)
        && settlementRecordAccess(req, context, 'CREDIT', {structureId: context.structureId}, 'read')
        && settlementRecordAccess(req, context, 'CREDIT', {structureId: context.structureId}, 'update');
}

export async function patientSettlementPositionView(req: Request, context: AuthorizedSettlementContext,
    options: {transaction?: Transaction; raw?: RawPatientSettlementPosition; administrationEnabled?: boolean} = {}): Promise<SettlementPositionView> {
    const raw = options.raw ?? await loadPatientSettlementPosition(req.tenantSchema!, context, {transaction: options.transaction});
    const administrationEnabled = options.administrationEnabled ?? await settlementAdministrationEnabled(req, options.transaction);
    const current = raw.current;
    const cutoff = raw.referenceEvent ? Date.parse(raw.referenceEvent.start) : raw.referenceInvoice
        ? Date.parse(current?.orderDate ?? raw.referenceInvoice.emissionDate) : Infinity;
    const visibleRaw = raw.obligations.filter(row => row.isCurrent || Date.parse(row.orderDate) <= cutoff);
    const obligations = visibleRaw.filter(row => settlementCanRead(req, context, row)).map(row => ({
        key: row.key, kind: row.kind, targetId: row.targetId, title: row.title, date: row.date, orderDate: row.orderDate,
        balance: row.balance, expectedAmount: row.expectedAmount, paidAmount: row.paidAmount, isCurrent: row.isCurrent,
        invoiceNumber: row.invoiceNumber, linkedEventIds: row.linkedEventIds,
        canCash: settlementCanCash(req, context, row), canUseCredit: settlementCanUseCredit(req, context, row, administrationEnabled)
    }));
    const first = raw.queue[0];
    const firstReadable = !first || settlementCanRead(req, context, first);
    const firstManageable = !first || settlementCanCash(req, context, first) || settlementCanUseCredit(req, context, first, administrationEnabled);
    const blocker = !firstReadable ? {kind: 'INACCESSIBLE_PRIOR' as const, message: 'Un obbligo precedente richiede un operatore autorizzato alla gestione economica.'}
        : !firstManageable ? {kind: 'READ_ONLY' as const, message: 'Non hai il permesso di saldare l’obbligo precedente.'} : null;
    const open = obligations.filter(row => (row.balance === null || row.balance > 0.009)
        && visibleRaw.find(item => item.key === row.key)?.eligible);
    const prior = open.filter(row => !row.isCurrent);
    const creditVisible = administrationEnabled && settlementRecordAccess(req, context, 'CREDIT', {structureId: context.structureId}, 'read');
    let creditsSummary: SettlementPositionView['creditsSummary'] = null;
    let packagesSummary: SettlementPositionView['packagesSummary'] = null;
    if (creditVisible) {
        const [credits, packages] = await Promise.all([
            PatientCredit.schema(req.tenantSchema!).findAll({where: {patientId: context.patientId, structureId: context.structureId, status: 'ACTIVE'}, transaction: options.transaction}),
            CarePackage.schema(req.tenantSchema!).findAll({where: {patientId: context.patientId, structureId: context.structureId, status: 'ACTIVE'}, transaction: options.transaction})
        ]);
        let verifiedRemaining = 0, unverifiedCount = 0;
        for (const model of credits) {
            const credit = model.get({plain: true});
            if (!(Number(credit.remainingAmount) > 0)) continue;
            if (await verifiedSettlementCredit(req.tenantSchema!, credit, options.transaction)) verifiedRemaining += Number(credit.remainingAmount);
            else unverifiedCount += 1;
        }
        const today = new Date().toLocaleDateString('en-CA', {timeZone: 'Europe/Rome'});
        const active = packages.map(model => model.get({plain: true})).filter(pkg => Number(pkg.remainingUnits) > 0
            && (!pkg.expiresAt || String(pkg.expiresAt).slice(0, 10) >= today));
        creditsSummary = {verifiedRemaining: paymentMoney(verifiedRemaining), unverifiedCount};
        packagesSummary = {activeCount: active.length, remainingUnits: active.reduce((sum, pkg) => sum + Number(pkg.remainingUnits), 0)};
    }
    const event = raw.referenceEvent;
    const currentReadable = !!current && settlementCanRead(req, context, current);
    const pricingEditable = !!event && !event.invoiceId && current?.kind !== 'INVOICE'
        && !event.recurrence && !event.recurringEventId && ['CONFIRMED', 'COMPLETED'].includes(String(event.status).toUpperCase())
        && Number.isFinite(Date.parse(event.start)) && Date.parse(event.start) <= Date.now()
        && settlementRecordAccess(req, context, 'APPOINTMENT', event, 'update');
    const visibleVerification = raw.verification.filter(row => Date.parse(row.record.start) <= cutoff
        && settlementRecordAccess(req, context, 'APPOINTMENT', row.record, 'read'));
    const calendarIds = [...new Set(visibleVerification.map(row => row.record.calendarId)
        .filter((id): id is string => typeof id === 'string' && SETTLEMENT_UUID.test(id)))];
    const operators = calendarIds.length ? await User.findAll({
        where: {id: {[Op.in]: calendarIds}}, attributes: ['id', 'name', 'surname'], transaction: options.transaction
    }) : [];
    const operatorNames = new Map<string, string | null>(operators.map(operator => [operator.id,
        [operator.name, operator.surname].map(value => value?.trim()).filter(Boolean).join(' ') || null]));
    const verification = visibleVerification.map(({record, ...view}) => ({
        ...view, start: typeof record.start === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(record.start)
            && Number.isFinite(Date.parse(record.start)) ? record.start : null,
        calendarId: record.calendarId ?? null,
        operatorName: operatorNames.get(record.calendarId) ?? null
    }));
    return {patientId: context.patientId, structureId: context.structureId,
        reference: {agendaEventId: context.referenceAgendaEventId ?? null, invoiceId: raw.referenceInvoice?.id ?? null,
            currentObligationKey: currentReadable ? current!.key : null, currentEligible: currentReadable && !!current?.eligible,
            unavailableReason: current?.unavailableReason ?? (!current ? 'Nessun obbligo corrente disponibile.' : null),
            summary: currentReadable ? {expectedAmount: current!.expectedAmount, paidAmount: current!.paidAmount, balance: current!.balance,
                paymentStatus: current!.balance === 0 ? 'paid' : current!.paidAmount > 0 ? 'partial' : current!.balance === null ? 'unknown' : 'unpaid',
                coverageSources: current!.coverageSources, methods: current!.methods, hasUndatedPayments: current!.hasUndatedPayments}
                : {expectedAmount: null, paidAmount: 0, balance: null, paymentStatus: 'unknown', coverageSources: [], methods: [], hasUndatedPayments: false},
            pricing: event ? {originalAmount: event.appointmentOriginalAmount == null ? event.appointmentPriceAdjustment
                ? null : current?.kind === 'APPOINTMENT' ? current.expectedAmount
                    : event.appointmentExpectedAmount == null ? null : paymentMoney(event.appointmentExpectedAmount)
                : paymentMoney(event.appointmentOriginalAmount),
                adjustment: event.appointmentPriceAdjustment ?? null, note: event.appointmentPriceAdjustmentNote ?? null, editable: pricingEditable} : null},
        obligations,
        verification,
        totals: {knownOutstandingAmount: paymentMoney(open.reduce((sum, row) => sum + (row.balance ?? 0), 0)),
            priorKnownOutstandingAmount: paymentMoney(prior.reduce((sum, row) => sum + (row.balance ?? 0), 0)),
            unknownPriceCount: open.filter(row => row.balance === null).length,
            priorUnknownPriceCount: prior.filter(row => row.balance === null).length, priorCount: prior.length},
        blocker, capabilities: {cash: obligations.some(row => row.canCash), credit: obligations.some(row => row.canUseCredit),
            packages: creditVisible && settlementRecordAccess(req, context, 'CREDIT', {structureId: context.structureId}, 'update')},
        creditsSummary, packagesSummary};
}

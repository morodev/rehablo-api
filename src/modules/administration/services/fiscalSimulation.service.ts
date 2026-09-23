import { Request } from 'express';
import { Model, Op, Transaction } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { patientScopeWhere, scopeWhere } from '../../../middleware/rbac.js';
import { Tenant } from '../../auth/models/index.js';
import { Invoice, InvoiceProduct, InvoiceService } from '../../invoice/models/index.js';
import { getPaymentSummaries } from '../../invoice/services/payment.service.js';
import { buildIssuerSnapshot } from '../../invoice/utils/issuer.js';
import { getStsFiscalSettings, resolveStsExpenseType } from '../../invoice/utils/stsExpenseType.js';
import Patient from '../../patients/models/patient.model.js';
import { FiscalSubmission } from '../models/index.js';
import { fiscalGateway } from './fiscalGateway.service.js';

type Plain = Record<string, any>;
export type FiscalChannel = 'STS' | 'SDI';
type Scenario = 'ACCEPTED' | 'REJECTED';
const money = (value: unknown) => Math.round((Number(value) || 0) * 100) / 100;
const plain = (row: Model): Plain => row.get({ plain: true });
const validUuid = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const fail = (statusCode: number, message: string): never => { throw Object.assign(new Error(message), { statusCode }); };

export function fiscalInvoiceScope(req: Request): Record<PropertyKey, unknown> {
    const patientScope = patientScopeWhere(req, req.tenantSchema!, 'patientID');
    return req.access?.scope === 'structure'
        ? { [Op.and]: [patientScope, scopeWhere(req, { structureField: 'structureId' })] }
        : patientScope;
}

function channelValue(value: unknown): FiscalChannel {
    if (value !== 'STS' && value !== 'SDI') fail(400, 'Seleziona il canale della simulazione');
    return value as FiscalChannel;
}

async function sourceInvoice(req: Request, documentId: unknown, transaction?: Transaction) {
    if (!validUuid(documentId)) fail(400, 'Seleziona una fattura valida');
    const invoice = await Invoice.schema(req.tenantSchema!).findOne({
        where: { [Op.and]: [{ id: documentId }, fiscalInvoiceScope(req)] },
        include: [
            { model: InvoiceProduct.schema(req.tenantSchema!), as: 'products' },
            { model: InvoiceService.schema(req.tenantSchema!), as: 'services' }
        ], transaction
    });
    if (!invoice) fail(404, 'Fattura non disponibile per questo accesso');
    return invoice!;
}

export function simulationSummary(row: Model | Plain, invoice?: Plain, patient?: Plain): Plain {
    const value = typeof row.get === 'function' ? plain(row as Model) : row as Plain;
    const snapshot = value.payloadSnapshot ?? {};
    const source = invoice ?? snapshot.invoice ?? {};
    const person = patient ?? snapshot.patient ?? {};
    return {
        id: value.id, channel: value.channel, documentType: value.documentType,
        documentId: value.documentId, status: value.status, provider: value.provider,
        externalId: value.externalId, protocolNumber: value.protocolNumber, attempts: value.attempts,
        lastError: value.lastError, submittedAt: value.submittedAt, completedAt: value.completedAt,
        createdAt: value.createdAt, isSimulation: value.provider === 'MOCK',
        documentNumber: source.documentNumber != null ? `${source.documentNumber}/${source.documentYear}` : null,
        patientName: [person.name, person.surname].filter(Boolean).join(' ') || null,
        amount: money(source.invoiceTotal ?? source.invoiceNet)
    };
}

/** Keep local simulation outcomes separate from actual transmission records. */
export function fiscalDocumentState(invoice: Plain, submissions: Plain[]): Plain {
    const real = submissions.find(row => row.provider !== 'MOCK');
    const simulated = submissions.find(row => row.provider === 'MOCK');
    return {
        fiscalStatus: real?.status ?? (invoice.stsSent ? 'UNVERIFIED' : 'NOT_SENT'),
        fiscalChannel: real?.channel ?? null,
        fiscalSimulationStatus: simulated?.status ?? null,
        fiscalSimulationChannel: simulated?.channel ?? null
    };
}

async function inspectInvoice(req: Request, invoice: Model, channel: FiscalChannel, transaction?: Transaction) {
    const data = { ...plain(invoice) };
    const [tenant, patient, summaries] = await Promise.all([
        Tenant.findByPk(getCurrentTenantId(req), { transaction }),
        validUuid(data.patientID) ? Patient.schema(req.tenantSchema!).findOne({
            where: { [Op.and]: [{ id: data.patientID }, patientScopeWhere(req, req.tenantSchema!, 'id')] },
            attributes: ['id', 'name', 'surname', 'fiscalCode', 'stsOppositionToDataSending'], transaction
        }) : Promise.resolve(null),
        getPaymentSummaries(req.tenantSchema!, [data], transaction)
    ]);
    // Match invoice display for legacy documents that predate the saved issuer snapshot.
    // Only the simulation snapshot is enriched; the source document is never updated.
    if (!data.issuer) {
        data.issuer = tenant ? buildIssuerSnapshot(plain(tenant)) : null;
        data.issuerIsFallback = true;
    }
    // A deleted/inaccessible linked patient must never be replaced with unscoped personal data.
    const person = patient ? plain(patient) : null;
    const paidAmount = summaries.get(String(data.id))?.paidAmount ?? 0;
    const issues: Array<{ field: string; message: string }> = [];
    const add = (field: string, message: string) => issues.push({ field, message });
    const enabled = (tenant?.get('featureFlags') as Plain | undefined)?.fiscalSandbox === true;
    if (!enabled) add('fiscalSandbox', 'Attiva l’ambiente di prova nelle impostazioni amministrative.');
    if (!Number.isInteger(Number(data.documentNumber)) || Number(data.documentNumber) < 1 || !data.documentYear)
        add('documentNumber', 'Salva una fattura con numero e anno prima di avviare la simulazione.');
    if (!data.emissionDate || !Number.isFinite(Date.parse(String(data.emissionDate))))
        add('emissionDate', 'Completa la data di emissione della fattura.');
    if (['void', 'draft'].includes(String(data.status).toLowerCase()))
        add('status', 'La simulazione richiede una fattura emessa e non annullata.');
    if (!Number.isFinite(Number(data.invoiceNet ?? data.invoiceTotal)) || Number(data.invoiceNet ?? data.invoiceTotal) <= 0)
        add('total', 'La simulazione richiede una fattura con importo maggiore di zero.');
    if (!person) add('patientID', 'Collega alla fattura un paziente disponibile per questo accesso.');
    else if (!String(person.fiscalCode ?? '').trim()) add('fiscalCode', 'Completa il codice fiscale nell’anagrafica del paziente.');
    if (!String(data.issuer?.businessName ?? '').trim()) add('issuer.businessName', 'Manca la denominazione dell’emittente salvata sulla fattura.');
    if (!String(data.issuer?.vatNumber ?? '').trim()) add('issuer.vatNumber', 'Manca la partita IVA dell’emittente salvata sulla fattura.');
    const sts = channel === 'STS' ? resolveStsExpenseType(data, getStsFiscalSettings(tenant ? plain(tenant) : null)) : null;
    if (sts?.stsExpenseTypeCode) data.stsExpenseTypeCode = sts.stsExpenseTypeCode;
    if (channel === 'STS') {
        if (data.stsExcluded) add('stsExcluded', 'La fattura è esclusa dal Sistema Tessera Sanitaria: verifica i dati del documento.');
        if (person?.stsOppositionToDataSending) add('stsOppositionToDataSending', 'Il paziente ha espresso opposizione all’invio al Sistema Tessera Sanitaria.');
        if (sts?.issue) add(sts.issue.field, sts.issue.message);
        if (paidAmount <= 0) add('paidAmount', 'Registra almeno un incasso della fattura prima di simulare il Sistema Tessera Sanitaria.');
    }
    return {
        preview: {
            documentId: data.id,
            documentNumber: data.documentNumber != null ? `${data.documentNumber}/${data.documentYear}` : 'Bozza',
            patientName: person ? [person.name, person.surname].filter(Boolean).join(' ') : null,
            channel, total: money(data.invoiceTotal ?? data.invoiceNet), paidAmount,
            ...(sts ? { stsExpenseTypeCode: sts.stsExpenseTypeCode, stsExpenseTypeSource: sts.stsExpenseTypeSource, stsIssuerType: sts.stsIssuerType } : {}),
            issues, canSimulate: issues.length === 0, isSimulation: true as const
        },
        snapshot: { invoice: data, patient: person, paidAmount, isSimulation: true },
        enabled
    };
}

export async function previewFiscal(req: Request, documentId: unknown, channel: unknown) {
    const selectedChannel = channelValue(channel);
    const invoice = await sourceInvoice(req, documentId);
    return (await inspectInvoice(req, invoice, selectedChannel)).preview;
}

export async function simulateFiscal(req: Request, source: Plain, previousId?: string) {
    const key = req.header('Idempotency-Key');
    if (!key || key.length > 128) fail(400, 'Identificativo della simulazione mancante o non valido');
    const scenario: Scenario = source.scenario ?? 'ACCEPTED';
    if (!['ACCEPTED', 'REJECTED'].includes(scenario)) fail(400, 'Seleziona un esito di prova valido');
    if (previousId && !validUuid(previousId)) fail(400, 'Simulazione non valida');
    return sequelize.transaction(async transaction => {
        await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:schema), hashtext(:key))', {
            replacements: { schema: req.tenantSchema!, key: 'fiscal:' + key }, transaction
        });
        const Submission = FiscalSubmission.schema(req.tenantSchema!);
        const previous = previousId ? await Submission.findByPk(previousId, { transaction }) : null;
        if (previousId && !previous) fail(404, 'Simulazione non disponibile');
        const documentId = previous?.get('documentId') ?? source.documentId;
        const channel = channelValue(previous?.get('channel') ?? source.channel);
        const invoice = await sourceInvoice(req, documentId, transaction);
        if (previous && (previous.get('provider') !== 'MOCK' || !['REJECTED', 'ERROR', 'FAILED'].includes(String(previous.get('status')))))
            fail(409, 'Puoi ripetere soltanto una simulazione non riuscita');
        const inspection = await inspectInvoice(req, invoice, channel, transaction);
        if (!inspection.enabled) fail(409, 'Attiva l’ambiente di prova nelle impostazioni amministrative');
        const prior = await Submission.findOne({ where: { idempotencyKey: key }, transaction });
        if (prior) {
            const priorPayload = prior.get('payloadSnapshot') as Plain;
            if (prior.get('provider') !== 'MOCK' || prior.get('documentId') !== documentId || prior.get('channel') !== channel
                || priorPayload?.scenario !== scenario || (priorPayload?.previousSubmissionId ?? null) !== (previousId ?? null))
                fail(409, 'Questa simulazione è già stata richiesta con dati diversi. Avvia una nuova prova.');
            return { status: 200, summary: simulationSummary(prior) };
        }
        if (!inspection.preview.canSimulate) fail(422, inspection.preview.issues.map(issue => issue.message).join(' '));
        const payload = { ...inspection.snapshot, scenario, previousSubmissionId: previousId ?? null };
        const gateway = fiscalGateway();
        // This route intentionally has no live provider path.
        if (!gateway.sandbox || gateway.provider !== 'MOCK') fail(409, 'Il servizio di simulazione non è disponibile');
        const result = await gateway.submit({ channel, documentId: String(documentId), payload });
        const submission = await Submission.create({
            channel, documentType: 'INVOICE', documentId, status: result.status, provider: gateway.provider,
            idempotencyKey: key, payloadSnapshot: payload, attempts: Number(previous?.get('attempts') ?? 0) + 1,
            submittedAt: new Date(), createdByUserId: req.access?.userId,
            externalId: result.externalId, protocolNumber: result.protocolNumber ?? null,
            lastError: result.error ?? null, completedAt: new Date()
        }, { transaction });
        // No Invoice.stsSent, stsSentAt, payment status or fiscal notes are changed by simulations.
        return { status: 201, summary: simulationSummary(submission) };
    });
}

/** Administrative counters describe real submissions, never simulated rejections. */
export async function visibleRealFiscalSubmissions(req: Request) {
    const schema = req.tenantSchema!;
    const invoices = await Invoice.schema(schema).findAll({ where: fiscalInvoiceScope(req), attributes: ['id'] });
    return FiscalSubmission.schema(schema).findAll({
        where: { documentId: { [Op.in]: invoices.map(invoice => invoice.get('id')) }, provider: { [Op.ne]: 'MOCK' } },
        order: [['createdAt', 'DESC']]
    });
}
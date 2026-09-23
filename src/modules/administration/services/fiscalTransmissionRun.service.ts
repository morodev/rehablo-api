/**
 * Servizio di trasmissione fiscale REALE: collega documento immutabile, payload, gateway e
 * macchina a stati, persistendo il tutto su `FiscalSubmission`.
 *
 * Sicurezza: il gateway è scelto dalla factory in base alla configurazione. Con la trasmissione
 * reale disabilitata (DEFAULT) usa il MOCK/sandbox e nessun dato lascia il gestionale. Con i
 * canali reali non configurati, la submission finisce in ACTION_REQUIRED, mai in un falso invio.
 *
 * Idempotenza: `Idempotency-Key` + lock advisory per schema garantiscono che un doppio invio non
 * crei due submission per la stessa richiesta.
 */

import crypto from 'node:crypto';
import { Request } from 'express';
import { Op } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { patientScopeWhere } from '../../../middleware/rbac.js';
import { Tenant } from '../../auth/models/index.js';
import { Invoice, InvoiceProduct, InvoiceService } from '../../invoice/models/index.js';
import Patient from '../../patients/models/patient.model.js';
import { getPaymentSummaries } from '../../invoice/services/payment.service.js';
import { buildIssuerSnapshot } from '../../invoice/utils/issuer.js';
import { buildRecipientSnapshot } from '../../invoice/utils/recipient.js';
import { InvoiceLineLike } from '../../invoice/utils/invoiceFatturaPa.js';
import { getStsFiscalSettings, resolveStsExpenseType } from '../../invoice/utils/stsExpenseType.js';
import { FiscalSubmission } from '../models/index.js';
import { buildSdiPayload, buildStsPayload, FiscalPayloadResult } from './fiscalPayload.js';
import { resolveTransmissionGateway } from './fiscalGatewayFactory.js';
import { loadStsCredentialsForTenant } from './stsCredentials.service.js';
import { runTransmission } from './fiscalTransmission.service.js';
import { isTerminalFiscalStatus } from './fiscalSubmissionState.js';
import { fiscalInvoiceScope, simulationSummary } from './fiscalSimulation.service.js';

type Plain = Record<string, any>;
const validUuid = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const fail = (statusCode: number, message: string): never => { throw Object.assign(new Error(message), { statusCode }); };

function toLines(plain: Plain): InvoiceLineLike[] {
    return [
        ...(plain.products ?? []).map((line: Plain): InvoiceLineLike => ({
            kind: 'PRODUCT', name: line.productName, vat: line.productVat, quantity: line.quantity, unitPrice: line.productPrice,
        })),
        ...(plain.services ?? []).map((line: Plain): InvoiceLineLike => ({
            kind: 'SERVICE', name: line.serviceName, vat: line.serviceVat, quantity: line.quantity, unitPrice: line.servicePrice,
        })),
    ];
}

async function buildPayloadForChannel(
    schema: string, channel: 'SDI' | 'STS', plain: Plain, tenantData: Plain, patient: Plain | null, transaction: any
): Promise<FiscalPayloadResult> {
    const issuer = plain.issuer ?? buildIssuerSnapshot(tenantData);
    const emissionDate = plain.emissionDate ? new Date(plain.emissionDate).toISOString().slice(0, 10) : null;

    if (channel === 'SDI') {
        const recipient = plain.recipient ?? (patient ? buildRecipientSnapshot(patient) : null);
        if (!recipient) return { channel: 'SDI', format: 'FatturaPA-FPR12', xml: null, errors: ['Destinatario del documento mancante.'] };
        const progressivo = `${plain.documentYear ?? new Date().getFullYear()}${String(plain.documentNumber ?? 0).padStart(5, '0')}`.slice(0, 10);
        return buildSdiPayload({
            issuer, recipient, lines: toLines(plain), progressivo,
            document: {
                documentType: plain.documentType, documentNumber: plain.documentNumber, documentYear: plain.documentYear,
                emissionDate, isStamp: plain.isStamp, stampAmount: plain.stampAmount, stampChargedToPatient: plain.stampChargedToPatient,
            },
        });
    }

    // Canale Sistema TS.
    const settings = getStsFiscalSettings(tenantData);
    const sts = resolveStsExpenseType({ ...plain, issuer }, settings);
    if (sts.issue) return { channel: 'STS', format: 'SistemaTS', xml: null, errors: [sts.issue.message] };
    const summaries = await getPaymentSummaries(schema, [plain], transaction);
    const paidAmount = summaries.get(String(plain.id))?.paidAmount ?? 0;
    return buildStsPayload({
        proprietario: {
            cfProprietario: issuer.vatNumber ?? issuer.taxCode ?? '',
            // Codice regione dell'erogatore: unico per la P.IVA (condiviso tra le sedi).
            codiceRegione: tenantData.administrationSettings?.fiscal?.codiceRegione ?? null,
        },
        invoice: { documentNumber: plain.documentNumber, documentYear: plain.documentYear, emissionDate },
        fiscalCode: patient?.fiscalCode ?? null,
        opposizione: Boolean(patient?.stsOppositionToDataSending),
        tipoSpesa: sts.stsExpenseTypeCode ?? '',
        // NOTA: data pagamento e tracciabilità puntuali richiedono l'aggregazione dei movimenti;
        // qui si usa la data di emissione come riferimento e tracciabile=true (da raffinare per il
        // Sistema TS reale, cfr. docs/fiscal-integration-setup.md).
        payment: { paidAmount, paidAt: emissionDate, traceable: true },
        annoFiscale: plain.documentYear ?? new Date().getFullYear(),
    });
}

/** Trasmette un documento sul canale indicato, creando/aggiornando la submission in modo idempotente. */
export async function transmitFiscalDocument(req: Request, source: Plain) {
    const key = req.header('Idempotency-Key');
    if (!key || key.length > 128) fail(400, 'Identificativo della trasmissione mancante o non valido');
    const channel = source.channel;
    if (channel !== 'SDI' && channel !== 'STS') fail(400, 'Seleziona il canale della trasmissione (SDI o STS)');
    const documentId = source.documentId;
    if (!validUuid(documentId)) fail(400, 'Seleziona una fattura valida');
    const schema = req.tenantSchema!;

    return sequelize.transaction(async transaction => {
        await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:schema), hashtext(:key))', {
            replacements: { schema, key: 'fiscal-tx:' + key }, transaction,
        });
        const Submission = FiscalSubmission.schema(schema);
        const prior = await Submission.findOne({ where: { idempotencyKey: key }, transaction });
        if (prior) return { status: 200, summary: simulationSummary(prior) };

        const invoice = await Invoice.schema(schema).findOne({
            where: { [Op.and]: [{ id: documentId }, fiscalInvoiceScope(req)] },
            include: [
                { model: InvoiceProduct.schema(schema), as: 'products' },
                { model: InvoiceService.schema(schema), as: 'services' },
            ], transaction,
        });
        if (!invoice) fail(404, 'Fattura non disponibile per questo accesso');
        const plain = invoice!.get({ plain: true }) as Plain;
        if (['void', 'draft'].includes(String(plain.status).toLowerCase())) fail(409, 'La trasmissione richiede una fattura emessa e non annullata.');

        const tenant = await Tenant.findByPk(getCurrentTenantId(req), { transaction });
        if (!tenant) fail(404, 'Struttura/tenant non trovato');
        const tenantData = tenant!.get({ plain: true }) as Plain;

        const patient = validUuid(plain.patientID)
            ? await Patient.schema(schema).findOne({
                where: { [Op.and]: [{ id: plain.patientID }, patientScopeWhere(req, schema, 'id')] },
                attributes: ['id', 'name', 'surname', 'fiscalCode', 'stsOppositionToDataSending', 'address', 'emails'], transaction,
            })
            : null;
        const patientPlain = patient ? (patient.get({ plain: true }) as Plain) : null;

        const payload = await buildPayloadForChannel(schema, channel, plain, tenantData, patientPlain, transaction);
        // Il canale TS usa le credenziali del SINGOLO studio (per-tenant); l'endpoint resta config
        // globale di Rehablo. Il canale SDI usa il provider globale.
        const stsOverride = channel === 'STS' ? loadStsCredentialsForTenant(tenantData) : null;
        const selection = resolveTransmissionGateway(channel, stsOverride);

        const xmlHash = payload.xml ? crypto.createHash('sha256').update(payload.xml).digest('hex') : null;
        const submission = await Submission.create({
            channel, documentType: 'INVOICE', documentId, status: 'QUEUED', provider: selection.gateway.provider,
            idempotencyKey: key, attempts: 0, createdByUserId: req.access?.userId,
            payloadSnapshot: { channel, format: payload.format, xmlHash, errors: payload.errors, gateway: selection.reason, live: selection.live },
        }, { transaction });

        const outcome = await runTransmission({
            currentStatus: 'QUEUED', payload, gateway: selection.gateway,
            request: { channel, documentId, format: payload.format, xml: payload.xml ?? '', idempotencyKey: key!, annoFiscale: plain.documentYear },
        });

        await submission.update({
            status: outcome.finalStatus, externalId: outcome.externalId, protocolNumber: outcome.protocolNumber,
            lastError: outcome.error, attempts: 1, submittedAt: new Date(),
            completedAt: isTerminalFiscalStatus(outcome.finalStatus) ? new Date() : null,
        }, { transaction });

        // Nessuna modifica a Invoice.stsSent/stsSentAt: lo stato reale vive sulla submission ed è
        // verificabile dal provider. I flag legacy restano quelli che erano.
        return { status: 201, summary: { ...simulationSummary(submission), gateway: selection.reason, live: selection.live } };
    });
}

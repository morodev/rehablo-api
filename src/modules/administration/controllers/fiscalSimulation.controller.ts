import { Op } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendSuccessResponse } from '../../../utils/response.js';
import { Invoice } from '../../invoice/models/index.js';
import Patient from '../../patients/models/patient.model.js';
import { FiscalSubmission } from '../models/index.js';
import { fiscalInvoiceScope, previewFiscal, simulateFiscal, simulationSummary } from '../services/fiscalSimulation.service.js';
import { transmitFiscalDocument } from '../services/fiscalTransmissionRun.service.js';

const source = (body: any) => body?.data ?? body ?? {};

export const previewFiscalSubmission = asyncHandler(async (req, res) => {
    const value = source(req.body);
    return sendSuccessResponse(res, 200, await previewFiscal(req, value.documentId, value.channel));
});

export const submitFiscal = asyncHandler(async (req, res) => {
    const result = await simulateFiscal(req, source(req.body));
    return sendSuccessResponse(res, result.status, result.summary, 'Esito della simulazione registrato. Nessun invio reale effettuato.');
});

/** Trasmissione REALE (gateway pilotato dalla configurazione: MOCK finché non abilitata). */
export const transmitFiscal = asyncHandler(async (req, res) => {
    const result = await transmitFiscalDocument(req, source(req.body));
    return sendSuccessResponse(res, result.status, result.summary, 'Richiesta di trasmissione registrata.');
});

export const retryFiscalSubmission = asyncHandler(async (req, res) => {
    const result = await simulateFiscal(req, source(req.body), req.params.id);
    return sendSuccessResponse(res, result.status, result.summary, 'Nuova simulazione registrata. Nessun invio reale effettuato.');
});

export const listFiscalSubmissions = asyncHandler(async (req, res) => {
    const schema = req.tenantSchema!;
    const invoices = await Invoice.schema(schema).findAll({ where: fiscalInvoiceScope(req) });
    const invoiceById = new Map(invoices.map(row => [String(row.get('id')), row.get({ plain: true }) as Record<string, any>]));
    const where: Record<string, any> = { documentId: { [Op.in]: [...invoiceById.keys()] } };
    if (req.query.status) where.status = req.query.status;
    if (req.query.channel) where.channel = req.query.channel;
    const [submissions, patients] = await Promise.all([
        FiscalSubmission.schema(schema).findAll({ where, order: [['createdAt', 'DESC']] }),
        Patient.schema(schema).findAll({
            where: { id: { [Op.in]: [...new Set([...invoiceById.values()].map(row => row.patientID).filter(Boolean))] } },
            attributes: ['id', 'name', 'surname']
        })
    ]);
    const patientById = new Map(patients.map(row => [String(row.get('id')), row.get({ plain: true })]));
    const query = String(req.query.query ?? '').trim().toLocaleLowerCase('it');
    const rows = submissions.map(row => {
        const invoice = invoiceById.get(String(row.get('documentId')))!;
        return simulationSummary(row, invoice, patientById.get(String(invoice.patientID)) ?? {});
    }).filter(row => !query || [row.documentNumber, row.patientName, row.channel, row.status, row.externalId]
        .some(value => String(value ?? '').toLocaleLowerCase('it').includes(query)));
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    return sendSuccessResponse(res, 200, { items: rows.slice(offset, offset + limit), total: rows.length, limit, offset });
});

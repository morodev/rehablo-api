import type {Request, Response} from 'express';
import {financialDiagnosticsDataset} from '../services/financialDiagnostics.service.js';
import {Op} from 'sequelize';
import {asyncHandler} from '../../../utils/asyncHandler.js';
import {sendErrorResponse, sendSuccessResponse} from '../../../utils/response.js';
import {AnalyticsQueryError} from '../services/analytics.service.js';
import {getReportAccess, resolveReportScope, resolvePersonalReportScope} from '../services/reportScope.service.js';
import {operationalDataset, operationalDiagnosticsDataset, OPERATIONAL_DATASETS, PERSONAL_DATASETS} from '../services/operationalReporting.service.js';
import {financialDataset, FINANCIAL_DATASETS} from '../services/financialReporting.service.js';
import {reportCsv, reportExportSnapshot, type ReportDatasetResponse} from '../services/reporting.types.js';
import {StructureUser, User} from '../../auth/models/index.js';
import EventType from '../../agenda/models/eventType.model.js';
import EventTypeStructure from '../../agenda/models/eventTypeStructure.model.js';
import {FinancialAccount, PaymentMethod} from '../../administration/models/administration.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import {methodKey} from '../services/finance.service.js';

async function execute(req: Request, dataset: string, allRows: boolean): Promise<ReportDatasetResponse> {
    if (dataset === 'financial-diagnostics') return financialDiagnosticsDataset(req, {allRows});
    if (dataset === 'operational-diagnostics') return operationalDiagnosticsDataset(req, {allRows});
    if ((FINANCIAL_DATASETS as readonly string[]).includes(dataset)) return financialDataset(req, dataset, {allRows});
    if ((OPERATIONAL_DATASETS as readonly string[]).includes(dataset)) return operationalDataset(req, dataset, {allRows});
    throw new AnalyticsQueryError('Report non riconosciuto');
}
function endpoint(fn: (req: Request, res: Response) => Promise<unknown>) {
    return asyncHandler(async (req, res) => {
        try {return await fn(req, res);} catch (error) {
            if (error instanceof AnalyticsQueryError) return sendErrorResponse(res, 400, error.message);
            const status = Number((error as any)?.statusCode);
            if (status >= 400 && status < 500) return sendErrorResponse(res, status, (error as Error).message);
            throw error;
        }
    });
}
export const reportReadScope = asyncHandler(async (req, _res, next) => {
    (req as any).reportScope = await resolveReportScope(req, {resource: 'analytics', action: 'read'});
    next();
});
export const getDataset = endpoint(async (req, res) => sendSuccessResponse(res, 200, await execute(req, req.params.dataset, false)));
export const exportDataset = endpoint(async (req, res) => {
    if (req.query.format != null && (typeof req.query.format !== 'string' || !['csv', 'json'].includes(req.query.format))) throw new AnalyticsQueryError('Formato export non supportato');
    (req as any).reportScope = await resolveReportScope(req, {resource: 'analytics', action: 'export'});
    const result = await execute(req, req.params.dataset, true);
    if (req.query.format === 'json') return sendSuccessResponse(res, 200, reportExportSnapshot(req.params.dataset, result));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report-${req.params.dataset}.csv"`);
    res.setHeader('X-Report-Generated-At', result.meta.generatedAt);
    return res.send(reportCsv(result));
});
export const getPersonal = endpoint(async (req, res) => {
    const dataset = req.query.dataset ?? 'activity-summary';
    if (typeof dataset !== 'string' || (dataset !== 'operational-diagnostics' && !(PERSONAL_DATASETS as readonly string[]).includes(dataset)) || (dataset === 'operational-diagnostics' && req.query.issueCode !== 'UNLINKED_PATIENTS')) {
        return sendErrorResponse(res, 403, 'Report non disponibile nel contesto personale');
    }
    (req as any).reportScope = await resolvePersonalReportScope(req);
    return sendSuccessResponse(res, 200, dataset === 'operational-diagnostics'
        ? await operationalDiagnosticsDataset(req, {personal: true}) : await operationalDataset(req, dataset, {personal: true}));
});
export const getAccess = endpoint(async (req, res) => {
    const access = await getReportAccess(req), ids = access.selectedStructureIds, schema = req.tenantSchema!;
    const [members, typeLinks, methods, accounts, invoices, events] = await Promise.all([
        StructureUser.findAll({where: {structureId: {[Op.in]: ids}}, attributes: ['userId']}),
        EventTypeStructure.schema(schema).findAll({where: {structureId: {[Op.in]: ids}}, attributes: ['eventTypeId']}),
        PaymentMethod.schema(schema).findAll({attributes: ['code', 'label']}),
        FinancialAccount.schema(schema).findAll({where: {[Op.or]: [{structureId: {[Op.in]: ids}}, {structureId: null}]}, attributes: ['id', 'name']}),
        Invoice.schema(schema).findAll({where: {structureId: {[Op.in]: ids}}, attributes: ['id']}),
        AgendaEvent.schema(schema).findAll({where: {structureId: {[Op.in]: ids}}, attributes: ['id', 'calendarId', 'eventTypeId']})
    ]);
    const operatorIds = [...new Set([...members.map(row => row.userId), ...events.map(row => row.calendarId).filter((id): id is string => !!id)])];
    const typeIds = [...new Set([...typeLinks.map(row => row.eventTypeId), ...events.map(row => row.eventTypeId).filter((id): id is string => !!id)])];
    const [users, eventTypes, payments] = await Promise.all([
        operatorIds.length ? User.findAll({where: {id: {[Op.in]: operatorIds}}, attributes: ['id', 'name', 'surname']}) : [],
        EventType.schema(schema).findAll({where: {[Op.or]: [{availabilityMode: 'ALL'}, {id: {[Op.in]: typeIds}}]}, attributes: ['id', 'title']}),
        invoices.length || events.length ? InvoicePayment.schema(schema).findAll({where: {[Op.or]: [{invoiceId: {[Op.in]: invoices.map(row => row.id)}}, {agendaEventId: {[Op.in]: events.map(row => row.id)}}]}, attributes: ['method']}) : []
    ]);
    const paymentMethods = [...new Set([...methods.map(row => String(row.get('label') ?? row.get('code'))), ...payments.map(row => methodKey(row.get('method')))])].sort((a, b) => a.localeCompare(b, 'it'));
    return sendSuccessResponse(res, 200, {...access, canExport: access.capabilities.canExport,
        operators: users.map(row => ({id: row.id, name: [row.name, row.surname].filter(Boolean).join(' ')})).sort((a, b) => a.name.localeCompare(b.name, 'it')),
        eventTypes: eventTypes.map(row => ({id: row.id, name: row.title})).sort((a, b) => a.name.localeCompare(b.name, 'it')),
        paymentMethods, accounts: accounts.map(row => ({id: String(row.get('id')), name: String(row.get('name'))}))});
});

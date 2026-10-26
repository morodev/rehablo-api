import type {Request} from 'express';
import {Op} from 'sequelize';
import {Expense, TreasuryMovement} from '../../administration/models/index.js';
import {resolveAdministrationDateRange} from '../../administration/services/administrationQuery.service.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import InvoicePayment from '../../invoice/models/invoicePayment.model.js';
import type {ReportScope} from './reportScope.service.js';
import type {FinancialWarning} from './financialFacts.service.js';

type Row = Record<string, any>;
export const UNASSIGNED_FINANCIAL_CODES = ['unassigned-documents', 'unassigned-appointments', 'unassigned-treasury', 'unassigned-expenses', 'unassigned-payments'] as const;
export type UnassignedFinancialCode = typeof UNASSIGNED_FINANCIAL_CODES[number];
export interface UnassignedFinancialSelector {code: UnassignedFinancialCode; label: string; model: any; where: Row; current: boolean;}

/** This is deliberately the same owner/all-authorized-sites gate for both badge and evidence. */
export function canReadUnassignedFinancial(req: Request, scope: ReportScope): boolean {
    return !!(req.user?.isSuperAdmin || req.user?.role === 'OWNER') && scope.selectedStructureIds.length === scope.allowedStructureIds.length;
}

/** One SQL predicate per category, reused by count and rows. Never infer a site from related records. */
export async function unassignedFinancialSelectors(req: Request, scope: ReportScope, from: string, to: string, dataset = 'financial-summary', issueCode?: string): Promise<UnassignedFinancialSelector[]> {
    if (!canReadUnassignedFinancial(req, scope)) return [];
    const period = resolveAdministrationDateRange(from, to);
    const timestampRange = {[Op.between]: [period.fromInstant!, period.toInstant!]};
    const dateRange = {[Op.between]: [from, to]};
    const current = dataset === 'receivables';
    const specs: UnassignedFinancialSelector[] = [];
    if (['financial-summary', 'documents', 'receivables'].includes(dataset) && (!issueCode || issueCode === 'unassigned-documents')) specs.push({code: 'unassigned-documents', label: 'Documenti', model: Invoice, current,
        where: {structureId: null, status: {[Op.notIn]: ['void', 'draft', 'cancelled']}, documentType: {[Op.in]: ['fattura', 'ricevuta', 'nota_di_credito']},
            ...(current ? {} : {emissionDate: dateRange})}});
    if (['financial-summary', 'receivables'].includes(dataset) && (!issueCode || issueCode === 'unassigned-appointments')) specs.push({code: 'unassigned-appointments', label: 'Sedute', model: AgendaEvent, current,
        where: {structureId: null, ...(current ? {start: {[Op.lte]: new Date()}} : {start: timestampRange})}});
    if (['financial-summary', 'treasury'].includes(dataset) && (!issueCode || issueCode === 'unassigned-treasury')) specs.push({code: 'unassigned-treasury', label: 'Movimenti di tesoreria', model: TreasuryMovement, current: false,
        where: {structureId: null, occurredAt: timestampRange}});
    if (['financial-summary', 'expenses'].includes(dataset) && (!issueCode || issueCode === 'unassigned-expenses')) specs.push({code: 'unassigned-expenses', label: 'Spese', model: Expense, current: false,
        where: {structureId: null, incurredAt: dateRange}});
    if (['financial-summary', 'payments'].includes(dataset) && (!issueCode || issueCode === 'unassigned-payments')) {
        const [invoices, events] = await Promise.all([
            Invoice.schema(req.tenantSchema!).findAll({where: {structureId: null}, attributes: ['id']}),
            AgendaEvent.schema(req.tenantSchema!).findAll({where: {structureId: null}, attributes: ['id']})
        ]);
        specs.push({code: 'unassigned-payments', label: 'Registrazioni di incasso', model: InvoicePayment, current: false,
            where: {paidAt: dateRange, carePackageId: null, source: {[Op.notIn]: ['CREDIT', 'PACKAGE', 'OPENING_BALANCE']}, [Op.and]: [
                {[Op.or]: [{invoiceId: null}, {invoiceId: {[Op.in]: invoices.map(row => row.get('id'))}}]},
                {[Op.or]: [{agendaEventId: null}, {agendaEventId: {[Op.in]: events.map(row => row.get('id'))}}]}
            ]}});
    }
    return specs;
}

export async function unassignedFinancialWarnings(req: Request, scope: ReportScope, from: string, to: string, dataset = 'financial-summary'): Promise<FinancialWarning[]> {
    const specs = await unassignedFinancialSelectors(req, scope, from, to, dataset);
    const counts = await Promise.all(specs.map(async spec => ({...spec, count: Number(await spec.model.schema(req.tenantSchema!).count({where: spec.where}))})));
    return counts.filter(row => row.count > 0).map(row => ({code: row.code, count: row.count,
        message: `${row.label} senza sede ${row.current ? 'nella situazione attuale' : 'nel periodo'}: esclusi dai totali; verificare l\u2019attribuzione della sede.`,
        drilldown: {dataset: 'financial-diagnostics', filters: {issueCode: row.code, sourceDataset: dataset, structureIds: scope.selectedStructureIds,
            ...(!row.current ? {from, to} : {}), ...(typeof req.query.query === 'string' && req.query.query ? {query: req.query.query} : {})}}}));
}

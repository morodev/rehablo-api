import type {Request} from 'express';
import {Op} from 'sequelize';
import Patient from '../../patients/models/patient.model.js';
import Invoice from '../../invoice/models/invoice.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import {canReadUnassignedFinancial, unassignedFinancialSelectors, UNASSIGNED_FINANCIAL_CODES} from './financialDiagnosticSelectors.service.js';
import {AnalyticsQueryError, parseAnalyticsQuery} from './analytics.service.js';
import {CASH_DIAGNOSTIC_CODES, dateOnly, type FinancialWarning} from './financialFacts.service.js';
import {financialSelection, loadFinanceData, money, parseFinanceFilters, type FinanceQuery} from './finance.service.js';
import {resolveReportScope, type ReportScope} from './reportScope.service.js';
import {paginateReport, type ReportDatasetResponse} from './reporting.types.js';

type Row = Record<string, any>;
export const FINANCIAL_DIAGNOSTIC_CODES = [...CASH_DIAGNOSTIC_CODES, 'unknown-appointment-balances', 'estimated-appointment-balances', 'mixed-documents', ...UNASSIGNED_FINANCIAL_CODES] as const;
export type FinancialDiagnosticCode = typeof FINANCIAL_DIAGNOSTIC_CODES[number];
const plain = (row: any): Row => typeof row.get === 'function' ? row.get({plain: true}) : row;
const isUnassignedIssue = (code: string) => (UNASSIGNED_FINANCIAL_CODES as readonly string[]).includes(code);
const isCashIssue = (code: string) => (CASH_DIAGNOSTIC_CODES as readonly string[]).includes(code);

/** A warning carries its actual classifier scope, never the graph's selected period. */
export function diagnosticScopeFilters(req: Request, query: FinanceQuery, scope: ReportScope, issueCode: string, sourceDataset = 'financial-summary'): Record<string, unknown> {
    const filters: Record<string, unknown> = {issueCode, sourceDataset, structureIds: scope.selectedStructureIds};
    if (typeof req.query.query === 'string' && req.query.query) filters.query = req.query.query;
    if (isUnassignedIssue(issueCode)) {
        if (sourceDataset !== 'receivables') {filters.from = query.from; filters.to = query.to;}
        return filters;
    }
    for (const key of ['operatorId', 'eventTypeId', 'eventTypeIds'] as const) if (query[key]) filters[key] = query[key];
    if (req.query.patientId) filters.patientId = req.query.patientId;
    // Cash warnings originate in loadFinanceData, before financialSelection payment/document filters.
    if (!isCashIssue(issueCode) && issueCode !== 'mixed-documents') {
        if (query.paymentStatus !== 'all') filters.paymentStatus = query.paymentStatus;
        if (query.documentStatus !== 'all') filters.documentStatus = query.documentStatus;
        if (query.paymentMethod) filters.paymentMethod = query.paymentMethod;
        if (query.statuses?.length) filters.status = query.statuses.join(',');
    }
    return filters;
}

/** Shared with financial-summary warnings so a badge and its list classify exactly the same obligations. */
export function appointmentBalanceIssues(selected: ReturnType<typeof financialSelection>) {
    return selected.events.filter(event => !event.invoiceId && event.appointmentPriceAdjustment !== 'COMPLIMENTARY')
        .map(event => ({event, financial: selected.financialByEvent.get(event.id)!}))
        .filter(({financial}) => financial.eligible);
}
export function withFinancialDiagnosticDrilldowns(warnings: FinancialWarning[], req: Request, query: FinanceQuery, scope: ReportScope, sourceDataset = 'financial-summary'): FinancialWarning[] {
    return warnings.map(warning => warning.drilldown ? warning : (FINANCIAL_DIAGNOSTIC_CODES as readonly string[]).includes(warning.code) && Number(warning.count) > 0
        ? {...warning, drilldown: {dataset: 'financial-diagnostics', filters: diagnosticScopeFilters(req, query, scope, warning.code, sourceDataset)}} : warning);
}

/** Read-only current/history evidence. No migration, inferred payment, or ledger correction is performed. */
export async function financialDiagnosticsDataset(req: Request, options: {allRows?: boolean} = {}): Promise<ReportDatasetResponse> {
    const code = req.query.issueCode;
    if (typeof code !== 'string' || !(FINANCIAL_DIAGNOSTIC_CODES as readonly string[]).includes(code)) throw new AnalyticsQueryError('Verifica economica non valida');
    const scope: ReportScope = (req as any).reportScope ?? await resolveReportScope(req, {resource: 'analytics', action: 'read'});
    if (scope.scope === 'own') throw Object.assign(new Error('Verifiche economiche non disponibili nel riepilogo personale'), {statusCode: 403});
    for (const key of ['query', 'diagnosticSearch', 'sourceDataset', 'page', 'size']) if (req.query[key] != null && typeof req.query[key] !== 'string') throw new AnalyticsQueryError('Filtro della verifica non valido');
    if (['query', 'diagnosticSearch'].some(key => typeof req.query[key] === 'string' && String(req.query[key]).length > 255)) throw new AnalyticsQueryError('Ricerca non valida');
    const sourceDataset = String(req.query.sourceDataset ?? 'financial-summary');
    if (!['financial-summary', 'documents', 'payments', 'treasury', 'expenses', 'receivables', 'activity-summary', 'sessions', 'operators', 'services', 'attendance-slots', 'capacity', 'patient-followups'].includes(sourceDataset)) throw new AnalyticsQueryError('Report di origine non valido');
    const page = Number(req.query.page ?? 1), size = Number(req.query.size ?? 25);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(size) || size < 1 || size > 200) throw new AnalyticsQueryError('Paginazione non valida');
    // Only unassigned period warnings follow the original report period. Other classifiers are current/history.
    const periodScope = isUnassignedIssue(code) && sourceDataset !== 'receivables';
    const {from: _from, to: _to, compare: _compare, granularity: _granularity, diagnosticSearch: _search, ...filters} = req.query;
    if (periodScope) {if (_from != null) filters.from = _from; if (_to != null) filters.to = _to;}
    const scopedRequest = Object.assign(Object.create(req), {query: {...filters, compare: 'none'}, reportScope: scope}) as Request;
    const query: FinanceQuery = {...parseAnalyticsQuery(scopedRequest), ...parseFinanceFilters(scopedRequest)};
    if (query.agendaEventIds) throw new AnalyticsQueryError('Filtro appuntamenti non valido per questa verifica');
    if (isUnassignedIssue(code)) return unassignedDiagnosticDataset(scopedRequest, query, scope, code, sourceDataset, page, size, req.query.diagnosticSearch, options.allRows);
    const data = await loadFinanceData(scopedRequest, query, scope);
    const names = new Map<string, string>();
    const patientIds = [...new Set([...data.invoices.map(row => row.patientID), ...data.events.map(row => row.patientId), ...(data.packages ?? []).map(row => row.patientId)].filter(Boolean))];
    const patients = patientIds.length ? await Patient.schema(req.tenantSchema!).findAll({where: {id: {[Op.in]: patientIds}}, attributes: ['id', 'name', 'surname']}) : [];
    patients.map(plain).forEach(row => names.set(row.id, [row.name, row.surname].filter(Boolean).join(' ')));
    const structures = new Map(scope.structures.map(row => [row.id, row.name]));
    const invoiceById = new Map(data.invoices.map(row => [row.id, row]));
    const eventById = new Map(data.events.map(row => [row.id, row]));
    const packageById = new Map((data.packages ?? []).map(row => [row.id, row]));
    const documentNumber = (invoice?: Row) => !invoice ? '' : invoice.documentNumber == null ? 'Documento senza numero' : `${invoice.documentNumber}/${invoice.documentYear ?? ''}`;
    let rows: Row[];
    if (code === 'mixed-documents') {
        rows = data.invoices.filter(invoice => data.excludedMixedInvoiceIds?.has(invoice.id)).map(invoice => ({
            id: `mixed-documents:${invoice.id}`, issueCode: code, reasonCode: 'mixed-document-context',
            reason: 'Le prestazioni collegate non consentono di attribuire interamente il documento al contesto selezionato.',
            sourceId: invoice.id, targetType: 'invoice', invoiceId: invoice.id,
            patientId: invoice.patientID ?? null, patient: names.get(invoice.patientID) || 'Paziente non disponibile',
            structureId: invoice.structureId, structure: structures.get(invoice.structureId) ?? 'Sede non disponibile',
            date: dateOnly(invoice.emissionDate) || null, document: documentNumber(invoice), description: 'Documento con attribuzione da verificare',
            status: invoice.status, statusLabel: financialDiagnosticStatus(invoice.status), origin: 'Documento',
            amount: nullableMoney(invoice.invoiceTotal), amountBasis: 'Totale del documento; non ripartito tra le prestazioni'}));
    } else if (isCashIssue(code)) {
        rows = (data.cashIssues ?? []).filter(issue => issue.issueCode === code).map(issue => {
            const payment = issue.payment;
            const invoice = invoiceById.get(payment.invoiceId), event = eventById.get(payment.agendaEventId), pkg = packageById.get(payment.carePackageId);
            const patientId = invoice?.patientID ?? pkg?.patientId ?? event?.patientId ?? null;
            const structureId = invoice?.structureId ?? pkg?.structureId ?? event?.structureId ?? null;
            return {id: issue.id, issueCode: code, reasonCode: issue.reasonCode, reason: issue.reason,
                paymentId: payment.id, status: payment.status,
                statusLabel: ({POSTED: 'Registrato', VOID: 'Annullato', CREDIT: 'Credito conservato'} as Row)[payment.status] ?? payment.status,
                source: payment.source, origin: payment.source === 'PACKAGE_PURCHASE' ? 'Acquisto pacchetto' : payment.source === 'APPOINTMENT' ? 'Seduta' : 'Documento',
                ...(invoice ? {invoiceId: invoice.id} : {}), ...(event ? {agendaEventId: event.id} : {}), ...(pkg ? {carePackageId: pkg.id} : {}),
                ...(issue.treasuryMovementId ? {treasuryMovementId: issue.treasuryMovementId, treasuryDate: dateOnly(issue.treasuryDate) || null, treasuryAmount: issue.treasuryAmount ?? null} : {}),
                sourceId: invoice?.id ?? pkg?.id ?? event?.id ?? payment.id,
                targetType: invoice ? 'invoice' : pkg ? 'package' : event ? 'appointment' : null,
                patientId, patient: names.get(patientId) || 'Paziente non disponibile', structureId, structure: structures.get(structureId) ?? 'Sede non disponibile',
                date: dateOnly(code === 'legacy-reversal-kind' ? issue.treasuryDate : payment.paidAt) || null, document: documentNumber(invoice),
                description: pkg?.name ?? event?.title ?? (invoice ? 'Incasso su documento' : 'Incasso clinico'),
                amount: code === 'legacy-reversal-kind' ? issue.treasuryAmount == null ? null : -issue.treasuryAmount : payment.amount == null || !Number.isFinite(Number(payment.amount)) ? null : money(payment.amount),
                amountBasis: code === 'legacy-reversal-kind' ? 'Importo della rettifica' : 'Importo registrato dell\u2019incasso',
                method: payment.method ?? 'Non specificato', ...(event ? {sourceEventId: event.id, start: event.start, occurrenceStart: event.start} : {})};
        });
    } else {
        const selected = financialSelection(data, query);
        rows = appointmentBalanceIssues(selected).filter(({financial}) => code === 'unknown-appointment-balances'
            ? financial.paymentStatus === 'unknown' : financial.priceEstimated && Number(financial.balance) > 0).map(({event, financial}) => {
            const missingPrice = financial.expectedAmount == null || financial.priceEstimated;
            const reasonCode = code === 'estimated-appointment-balances' ? 'estimated-price' : financial.issueKind === 'UNKNOWN_PREVIOUS_PAYMENT' ? 'unknown-payment-history' : missingPrice ? 'unverified-price' : 'unknown-balance';
            const reason = reasonCode === 'estimated-price' ? 'Residuo calcolato su una tariffa stimata.'
                : reasonCode === 'unknown-payment-history' ? 'Storico degli incassi della seduta da verificare.'
                    : reasonCode === 'unverified-price' ? 'Prezzo della seduta assente o non confermato.' : 'Saldo della seduta non determinabile con i dati registrati.';
            return {id: `${code}:${event.id}`, issueCode: code, reasonCode, reason,
                sourceId: event.id, targetType: 'appointment', sourceEventId: event.id, agendaEventId: event.id, start: event.start, occurrenceStart: event.start,
                status: event.status, statusLabel: ({CONFIRMED: 'Confermata', COMPLETED: 'Effettuata'} as Row)[event.status] ?? event.status, origin: 'Seduta',
                patientId: event.patientId ?? null, patient: names.get(event.patientId) || 'Paziente non disponibile',
                structureId: event.structureId, structure: structures.get(event.structureId) ?? 'Sede non disponibile', date: dateOnly(event.start) || null,
                document: '', description: event.title ?? 'Seduta', amount: code === 'unknown-appointment-balances' ? null : financial.balance,
                amountBasis: code === 'unknown-appointment-balances' ? 'Da verificare' : 'Tariffa stimata'};
        });
    }
    return diagnosticResponse(rows, diagnosticScopeFilters(scopedRequest, query, scope, code, sourceDataset), page, size, req.query.diagnosticSearch, !!options.allRows, 'current_history');
}


const nullableMoney = (value: unknown): number | null => value == null || !Number.isFinite(Number(value)) ? null : money(value);
const financialDiagnosticStatus = (status: unknown): string => ({POSTED: 'Registrato', VOID: 'Annullato', CREDIT: 'Credito conservato', PAID: 'Pagato',
    PARTIAL: 'Parziale', UNPAID: 'Da pagare', OPEN: 'Aperto', CANCELLED: 'Annullato', CONFIRMED: 'Confermata', COMPLETED: 'Effettuata', NO_SHOW: 'Assenza', PENDING: 'In attesa'} as Row)[String(status).toUpperCase()] ?? String(status ?? 'Non specificato');

function diagnosticResponse(rows: Row[], effectiveFilters: Row, page: number, size: number, diagnosticSearch: unknown, allRows: boolean, dateBasis: 'current_history' | 'period'): ReportDatasetResponse {
    const categoryTotal = rows.length;
    const search = String(diagnosticSearch ?? '').trim().toLocaleLowerCase('it');
    rows = rows.filter(row => !search || [row.patient, row.document, row.description, row.reason, row.method, row.sourceId, row.paymentId, row.structure, row.statusLabel]
        .filter(Boolean).join(' ').toLocaleLowerCase('it').includes(search));
    rows.sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || String(a.id).localeCompare(String(b.id)));
    const generatedAt = new Date().toISOString();
    return {meta: {effectiveFilters: {...effectiveFilters, ...(search ? {diagnosticSearch: String(diagnosticSearch).trim()} : {})},
        generatedAt, balanceAsOf: generatedAt, dateBasis, comparisonPeriod: null, warnings: []},
        summary: [{key: 'categoryTotal', label: 'Totale da verificare', value: categoryTotal, format: 'number',
            description: dateBasis === 'period' ? 'Registrazioni senza sede nel periodo del report di origine.' : 'Situazione attuale e storico delle sedi e del contesto selezionati; indipendente dal periodo del grafico.'}],
        columns: [{key: 'date', label: 'Data', type: 'date'}, {key: 'patient', label: 'Paziente'}, {key: 'structure', label: 'Sede'}, {key: 'document', label: 'Documento'},
            {key: 'description', label: 'Origine'}, {key: 'statusLabel', label: 'Stato'}, {key: 'amount', label: 'Importo', type: 'currency'},
            {key: 'amountBasis', label: 'Criterio importo'}, {key: 'reason', label: 'Motivo della verifica'}],
        ...paginateReport(rows, page, size, allRows)};
}

async function unassignedDiagnosticDataset(req: Request, query: FinanceQuery, scope: ReportScope, code: string, sourceDataset: string, page: number, size: number,
    diagnosticSearch: unknown, allRows = false): Promise<ReportDatasetResponse> {
    if (!canReadUnassignedFinancial(req, scope)) throw Object.assign(new Error('Verifiche senza sede riservate al titolare con tutte le sedi selezionate'), {statusCode: 403});
    const selectors = await unassignedFinancialSelectors(req, scope, query.from, query.to, sourceDataset, code);
    const selector = selectors.find(row => row.code === code);
    if (!selector) throw new AnalyticsQueryError('Verifica non disponibile per il report di origine');
    const selected: Row[] = (await selector.model.schema(req.tenantSchema!).findAll({where: selector.where})).map(plain);
    let orphanInvoices: Row[] = [], orphanEvents: Row[] = [];
    if (code === 'unassigned-payments') {
        const invoiceIds = [...new Set(selected.map(row => row.invoiceId).filter(Boolean))], eventIds = [...new Set(selected.map(row => row.agendaEventId).filter(Boolean))];
        [orphanInvoices, orphanEvents] = await Promise.all([
            invoiceIds.length ? Invoice.schema(req.tenantSchema!).findAll({where: {id: {[Op.in]: invoiceIds}, structureId: null}}).then(rows => rows.map(plain)) : [],
            eventIds.length ? AgendaEvent.schema(req.tenantSchema!).findAll({where: {id: {[Op.in]: eventIds}, structureId: null}}).then(rows => rows.map(plain)) : []
        ]);
    }
    const invoiceById = new Map(orphanInvoices.map(row => [row.id, row])), eventById = new Map(orphanEvents.map(row => [row.id, row]));
    const patientIds = [...new Set([...selected.map(row => row.patientID ?? row.patientId), ...orphanInvoices.map(row => row.patientID), ...orphanEvents.map(row => row.patientId)].filter(Boolean))];
    const patients = patientIds.length ? await Patient.schema(req.tenantSchema!).findAll({where: {id: {[Op.in]: patientIds}}, attributes: ['id', 'name', 'surname']}) : [];
    const names = new Map(patients.map(plain).map(row => [row.id, [row.name, row.surname].filter(Boolean).join(' ')]));
    const rows = selected.map(row => {
        const invoice = code === 'unassigned-documents' ? row : invoiceById.get(row.invoiceId);
        const event = code === 'unassigned-appointments' ? row : eventById.get(row.agendaEventId);
        const patientId = invoice?.patientID ?? event?.patientId ?? null;
        const targetType = invoice ? 'invoice' : event ? 'appointment' : code === 'unassigned-treasury' ? 'treasury' : code === 'unassigned-expenses' ? 'expense' : 'payment';
        const amount = code === 'unassigned-documents' ? nullableMoney(row.invoiceTotal) : code === 'unassigned-appointments' ? nullableMoney(row.appointmentExpectedAmount) : nullableMoney(row.amount);
        return {id: code + ':' + row.id, issueCode: code, reasonCode: 'missing-structure', reason: 'Registrazione senza sede: esclusa dai totali del report, da attribuire alla sede corretta.',
            sourceId: invoice?.id ?? event?.id ?? row.id, targetType, patientId, patient: patientId ? names.get(patientId) || 'Paziente non disponibile' : 'Non applicabile',
            structureId: null, structure: 'Senza sede', date: dateOnly(row.emissionDate ?? row.start ?? row.occurredAt ?? row.incurredAt ?? row.paidAt) || null,
            document: invoice?.documentNumber == null ? '' : String(invoice.documentNumber) + '/' + String(invoice.documentYear ?? ''),
            description: row.title ?? row.description ?? (code === 'unassigned-documents' ? 'Documento emesso' : code === 'unassigned-payments' ? 'Incasso clinico' : selector.label),
            status: row.status, statusLabel: financialDiagnosticStatus(row.status), amount,
            amountBasis: amount === null ? 'Da verificare' : code === 'unassigned-appointments' ? 'Prezzo registrato della seduta' : 'Importo registrato',
            ...(invoice ? {invoiceId: invoice.id} : {}), ...(event ? {agendaEventId: event.id, sourceEventId: event.id, start: event.start, occurrenceStart: event.start} : {}),
            ...(code === 'unassigned-payments' ? {paymentId: row.id, method: row.method ?? 'Non specificato', source: row.source} : {}),
            ...(code === 'unassigned-treasury' ? {treasuryMovementId: row.id, direction: row.direction === 'OUT' ? 'Uscita' : 'Entrata', category: row.category} : {})};
    });
    return diagnosticResponse(rows, diagnosticScopeFilters(req, query, scope, code, sourceDataset), page, size, diagnosticSearch, allRows, selector.current ? 'current_history' : 'period');
}

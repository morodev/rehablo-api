import type {Request} from 'express';
import {Op} from 'sequelize';
import rrulePackage from 'rrule';
import Patient from '../../patients/models/patient.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import AgendaEventException from '../../agenda/models/agendaEventException.model.js';
import TimeOffRequest from '../../agenda/models/timeOffRequest.model.js';
import ProtocolInstance from '../../protocols/models/protocolInstance.model.js';
import InvoiceProduct from '../../invoice/models/invoiceProduct.model.js';
import InvoiceService from '../../invoice/models/invoiceService.model.js';
import {CarePackage} from '../../administration/models/administration.model.js';
import {StructureUser, StructureUserAvailability, StructureAvailability, TenantUser, User} from '../../auth/models/index.js';
import {resolveReportScope, resolvePersonalReportScope, resolveOptionalReportScope, type ReportScope} from './reportScope.service.js';
import {addDays, aggregateActivity, AnalyticsQueryError, comparisonRange, documentDiscountRatio, loadOccurrences, localDateKey, localMinute,
    parseAnalyticsQuery, percentageChange, rangesOfRow, type AnalyticsQuery, type ReportOccurrence} from './analytics.service.js';
import {aggregateTherapyPayments, loadFinanceData, parseFinanceFilters} from './finance.service.js';
import {dateOnly, validIssuedDocument, documentSign} from './financialFacts.service.js';
import {capacityValues, followupEligible, type Interval} from './operationalMetrics.js';
import {paginateReport, type ReportDatasetResponse, type ReportColumn, type ReportSummaryItem, type ReportMeta} from './reporting.types.js';

export const OPERATIONAL_DATASETS = ['activity-summary', 'sessions', 'operators', 'services', 'attendance-slots', 'capacity', 'patient-followups'] as const;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const plain = (row: any): Record<string, any> => typeof row.get === 'function' ? row.get({plain: true}) : row;
const round = (value: number) => Math.round(value * 100) / 100;
const weekday = (date: Date) => (new Date(localDateKey(date) + 'T12:00:00Z').getUTCDay() + 6) % 7;
const statusLabels: Record<string, string> = {COMPLETED: 'Effettuata', CANCELLED: 'Disdetta', NO_SHOW: 'Assenza', CONFIRMED: 'Confermata'};
const col = (key: string, label: string, type: ReportColumn['type'] = 'number'): ReportColumn => ({key, label, type});
const item = (key: string, label: string, value: number | null, format: ReportSummaryItem['format'] = 'number', description?: string): ReportSummaryItem => ({key, label, value, format, ...(description ? {description} : {})});
function integer(req: Request, key: string, fallback: number, min: number, max: number): number {
    if (req.query[key] == null || req.query[key] === '') return fallback;
    if (typeof req.query[key] !== 'string' || !/^\d+$/.test(req.query[key] as string)) throw new AnalyticsQueryError(`${key}: valore non valido`);
    const value = Number(req.query[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new AnalyticsQueryError(`${key}: valore non valido`);
    return value;
}
function optionalId(req: Request, key: string): string | null {
    const value = req.query[key];
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !UUID.test(value)) throw new AnalyticsQueryError(`${key}: identificativo non valido`);
    return value;
}
function sessionFilters(req: Request) {
    for (const key of ['status', 'query']) {
        if (req.query[key] != null && typeof req.query[key] !== 'string') throw new AnalyticsQueryError(`${key}: valore non valido`);
    }
    const status = req.query.status == null || req.query.status === '' ? null : String(req.query.status).toUpperCase();
    if (status && !['COMPLETED', 'CANCELLED', 'NO_SHOW', 'CONFIRMED', 'UNRESOLVED'].includes(status)) throw new AnalyticsQueryError('Stato seduta non valido');
    const query = req.query.query == null ? '' : String(req.query.query).trim();
    if (query.length > 200) throw new AnalyticsQueryError('Ricerca troppo lunga');
    return {status, patientId: optionalId(req, 'patientId'), query,
        weekday: integer(req, 'weekday', -1, 0, 6), hour: integer(req, 'hour', -1, 0, 23)};
}
function selectSessions(rows: ReportOccurrence[], filters: ReturnType<typeof sessionFilters>, now: Date) {
    return rows.filter(row => (!filters.status || (filters.status === 'UNRESOLVED'
        ? row.status === 'CONFIRMED' && row.end < now : row.status === filters.status)) &&
        (!filters.patientId || row.patientId === filters.patientId) &&
        (!filters.query || `${row.patientName} ${row.title ?? ''}`.toLocaleLowerCase('it').includes(filters.query.toLocaleLowerCase('it'))) &&
        (filters.weekday < 0 || weekday(row.start) === filters.weekday) && (filters.hour < 0 || Math.floor(localMinute(row.start) / 60) === filters.hour));
}
function rowsForSessions(rows: ReportOccurrence[], operatorNames: Map<string, string>) {
    return [...rows].sort((a, b) => b.start.getTime() - a.start.getTime() || a.id.localeCompare(b.id)).map(row => ({
        id: row.id, sourceId: row.sourceEventId, targetType: 'appointment', patientId: row.patientId, invoiceId: row.invoiceId,
        occurrenceStart: row.start.toISOString(), start: row.start.toISOString(), patientName: row.patientName,
        title: row.title ?? 'Prestazione non indicata', status: statusLabels[row.status] ?? row.status,
        operatorId: row.calendarId, operatorName: operatorNames.get(row.calendarId ?? '') ?? 'Non assegnato',
        durationMinutes: row.durationMinutes, structureId: row.structureId, eventTypeId: row.eventTypeId}));
}
const sessionColumns = [col('start', 'Data seduta', 'datetime'), col('patientName', 'Paziente', 'text'), col('title', 'Prestazione', 'text'),
    col('operatorName', 'Professionista', 'text'), col('status', 'Stato', 'text'), col('durationMinutes', 'Durata prevista (min)')];

export async function operationalDataset(req: Request, dataset: string, options: {allRows?: boolean; personal?: boolean} = {}): Promise<ReportDatasetResponse> {
    if (!OPERATIONAL_DATASETS.includes(dataset as any)) throw new AnalyticsQueryError('Report non valido');
    if (options.personal && dataset !== 'activity-summary') throw new AnalyticsQueryError('Il riepilogo personale comprende solo la propria attività');
    const scope: ReportScope = (req as any).reportScope ?? await (options.personal ? resolvePersonalReportScope(req) : resolveReportScope(req, {resource: 'analytics', action: 'read'}));
    const scopedReq = {...req, query: {...req.query}, reportScope: scope} as unknown as Request;
    const now = new Date(), today = localDateKey(now);
    if (dataset === 'capacity') {
        scopedReq.query = {...req.query, from: req.query.from ?? today, to: req.query.to ?? addDays(today, 27), compare: 'none'};
    }
    if (dataset === 'patient-followups') {
        const lookback = integer(req, 'lookbackDays', 180, 1, 735);
        if (integer(req, 'thresholdDays', 30, 1, 735) > lookback) throw new AnalyticsQueryError('La soglia deve rientrare nel periodo di osservazione');
        scopedReq.query = {...req.query, from: addDays(today, -lookback + 1), to: today, compare: 'none'};
    }
    const query = parseAnalyticsQuery(scopedReq), filters = sessionFilters(req);
    const page = integer(req, 'page', 1, 1, 1000000), size = integer(req, 'size', 25, 1, 100);
    const meta: ReportMeta = {effectiveFilters: {...query, structureIds: scope.selectedStructureIds, ...filters},
        generatedAt: now.toISOString(), dateBasis: dataset === 'patient-followups' ? 'current' : 'appointment', warnings: []};
    if (dataset === 'capacity') return capacityDataset(req, query, scope, meta, page, size, !!options.allRows, now);
    if (dataset === 'patient-followups') return followupDataset(req, query, scope, meta, page, size, !!options.allRows, now);
    const allOccurrences = await loadOccurrences(req.tenantSchema!, query);
    let rows = selectSessions(allOccurrences, filters, now);
    const financeQuery = dataset === 'sessions' ? {...query, ...parseFinanceFilters({...scopedReq, query: {...req.query, status: undefined}} as unknown as Request)} : null;
    const finance = financeQuery ? await loadFinanceData(scopedReq, financeQuery, scope) : null;
    const therapy = finance && financeQuery ? aggregateTherapyPayments(finance, financeQuery, rows, 1, Math.max(rows.length, 1)) : null;
    if (therapy) {
        const selected = new Set(therapy.details.map(row => row.id));
        rows = rows.filter(row => selected.has(row.id));
        meta.effectiveFilters = {...meta.effectiveFilters, paymentStatus: financeQuery!.paymentStatus, documentStatus: financeQuery!.documentStatus, paymentMethod: financeQuery!.paymentMethod};
        meta.balanceAsOf = therapy.balanceAsOf;
        meta.warnings.push(...(finance!.warnings ?? []), {code: 'SESSION_FINANCIAL_SNAPSHOT', message: 'Periodo per data seduta; pagamenti e residui aggiornati a oggi. Gli importi di fatture cumulative sono mostrati una sola volta nei totali documento, senza ripartizione sulle sedute.'});
    }
    const activity = await aggregateActivity(req.tenantSchema!, query, rows);
    const priorQuery = comparisonRange(query);
    let priorRows = priorQuery ? selectSessions(await loadOccurrences(req.tenantSchema!, priorQuery), filters, now) : [];
    if (priorQuery && finance && financeQuery) {
        const priorTherapy = aggregateTherapyPayments(finance, {...financeQuery, ...priorQuery}, priorRows, 1, Math.max(priorRows.length, 1));
        const selected = new Set(priorTherapy.details.map(row => row.id));
        priorRows = priorRows.filter(row => selected.has(row.id));
    }
    const previous = priorQuery ? await aggregateActivity(req.tenantSchema!, priorQuery, priorRows) : null;
    meta.comparisonPeriod = priorQuery ? {from: priorQuery.from, to: priorQuery.to} : null;
    const totals = activity.totals, resolved = totals.completed + totals.cancelled + totals.noShow;
    const summary: ReportSummaryItem[] = [item('total', 'Sedute nel periodo', totals.total), item('completed', 'Effettuate', totals.completed),
        item('cancelled', 'Disdette', totals.cancelled), item('noShow', 'Assenze', totals.noShow), item('deliveredMinutes', 'Minuti erogati', totals.deliveredMinutes, 'minutes', 'Durata pianificata delle sedute completate'),
        item('cancellationRate', 'Tasso disdette', resolved ? round(totals.cancelled / resolved * 100) : null, 'percent', 'Disdette / (effettuate + disdette + assenze)'),
        item('noShowRate', 'Tasso assenze', resolved ? round(totals.noShow / resolved * 100) : null, 'percent'),
        item('pastUnresolved', 'Sedute passate da verificare', totals.pastUnresolved)];
    for (const metric of summary) {
        if (previous) {
            const prevResolved = previous.totals.completed + previous.totals.cancelled + previous.totals.noShow;
            metric.previousValue = metric.format === 'percent' && !prevResolved ? null : (previous.totals as any)[metric.key];
            metric.change = metric.value == null || metric.previousValue == null ? null : metric.format === 'percent'
                ? round(metric.value - metric.previousValue) : percentageChange(metric.value, metric.previousValue);
        }
        const status = ({completed: 'COMPLETED', cancelled: 'CANCELLED', noShow: 'NO_SHOW', pastUnresolved: 'UNRESOLVED'} as Record<string, string>)[metric.key];
        if (metric.format !== 'percent') metric.drilldown = {dataset: 'sessions', filters: status ? {status} : {}};
    }
    const missing = rows.filter(row => !row.patientId).length;
    if (missing) meta.warnings.push({code: 'UNLINKED_PATIENTS', count: missing, message: 'Sedute senza collegamento al paziente: escluse dagli indicatori pazienti.'});
    const names = new Map(activity.operators.map(row => [row.operatorId, row.operatorName]));
    if (dataset === 'sessions' && therapy) {
        const financeById = new Map(therapy.details.map(row => [row.id, row]));
        const paidLabels: Record<string, string> = {paid: 'Pagato', partial: 'Parziale', unpaid: 'Da pagare', unknown: 'Non determinabile', void: 'Annullato'};
        const output = rowsForSessions(rows, names).map(row => {
            const financial = financeById.get(row.id)!;
            const complimentary = financial.appointmentPriceAdjustment === 'COMPLIMENTARY';
            return {...row, ...financial, status: row.status,
                paymentStatusLabel: complimentary ? 'Omaggio' : paidLabels[financial.paymentStatus],
                invoicePaymentStatusLabel: financial.invoicePaymentStatus ? paidLabels[financial.invoicePaymentStatus] ?? financial.invoicePaymentStatus : null,
                documentStatus: complimentary ? 'Omaggio' : financial.invoiceId ? 'Fatturata' : 'Da fatturare',
                paymentScopeLabel: financial.paymentScope === 'invoice' ? 'Documento cumulativo' : 'Seduta',
                paymentMethodsLabel: financial.paymentMethods.map(method => method === '__unspecified__' ? 'Non specificato' : method).join(', '),
                priceBasis: financial.expectedAmount == null ? 'Non disponibile' : complimentary ? 'Omaggio' : financial.priceEstimated ? 'Tariffa stimata' : 'Prezzo confermato'};
        });
        const values = therapy.totals;
        summary.push(item('expectedAmount', 'Valore previsto sedute', values.expectedAmount, 'currency', 'Somma dei prezzi noti, incluse le tariffe stimate; prezzi non disponibili esclusi'),
            item('collected', 'Incassi attribuiti alle sedute', values.collected, 'currency', 'Movimenti reali attribuiti alle sedute selezionate, a oggi'),
            item('outstanding', 'Residuo sedute non fatturate', values.outstanding, 'currency', 'Solo residui noti delle sedute senza fattura'),
            item('invoiceCollected', 'Incassi sui documenti collegati', values.invoiceCollected, 'currency', 'Documenti contati una volta e attribuibili interamente al contesto; nessuna ripartizione sulle sedute'),
            item('invoiceOutstanding', 'Residuo documenti collegati', values.invoiceOutstanding, 'currency', 'Saldo attuale dei documenti attribuibili interamente al contesto'),
            item('unknownCount', 'Storico pagamenti non determinabile', values.unknownCount),
            item('unknownPriceCount', 'Prezzi non disponibili', values.unknownPriceCount),
            item('estimatedPriceCount', 'Prezzi stimati', values.estimatedPriceCount),
            item('invoiceManagedCount', 'Sedute gestite sul documento', values.invoiceManagedCount));
        return {meta, summary, columns: [...sessionColumns, col('expectedAmount', 'Prezzo seduta', 'currency'), col('priceBasis', 'Origine prezzo', 'text'),
            col('paidAmount', 'Pagato sulla seduta', 'currency'), col('balance', 'Residuo seduta noto', 'currency'), col('paymentStatusLabel', 'Pagamento seduta', 'text'),
            col('documentStatus', 'Documento', 'text'), col('paymentScopeLabel', 'Ambito pagamento', 'text'), col('invoicePaymentStatusLabel', 'Pagamento documento', 'text'),
            col('paymentMethodsLabel', 'Metodi pagamento', 'text')], ...paginateReport(output, page, size, options.allRows)};
    }
    if (dataset === 'activity-summary') {
        const activeIds = new Set(rows.filter(row => row.status === 'COMPLETED' && row.patientId).map(row => row.patientId!));
        const priorActiveIds = new Set(previous?.details.filter(row => row.status === 'COMPLETED' && row.patientId).map(row => row.patientId!) ?? []);
        const historyIds = [...new Set([...activeIds, ...priorActiveIds])];
        const history = historyIds.length ? await AgendaEvent.schema(req.tenantSchema!).findAll({where: {
            patientId: {[Op.in]: historyIds}, structureId: {[Op.in]: scope.selectedStructureIds}, status: 'COMPLETED',
            ...(query.operatorId ? {calendarId: query.operatorId} : {})}, attributes: ['patientId', 'start']}) : [];
        const first = new Map<string, string>();
        history.forEach(event => {const date = event.start ? localDateKey(new Date(event.start)) : ''; if (date && (!first.has(event.patientId!) || date < first.get(event.patientId!)!)) first.set(event.patientId!, date);});
        const firstCount = (ids: Set<string>, from: string, to: string) => [...first.entries()].filter(([id, date]) => ids.has(id) && date >= from && date <= to).length;
        const patientMetrics = [item('activePatients', 'Pazienti con sedute effettuate', activeIds.size), item('newClinical', 'Prima seduta nel contesto', firstCount(activeIds, query.from, query.to),
            'number', 'Prima seduta completata nella sede e con il professionista selezionati, fra i pazienti delle prestazioni selezionate')];
        if (priorQuery) {
            patientMetrics[0].previousValue = priorActiveIds.size;
            patientMetrics[1].previousValue = firstCount(priorActiveIds, priorQuery.from, priorQuery.to);
            patientMetrics.forEach(metric => metric.change = percentageChange(metric.value!, metric.previousValue!));
        }
        summary.push(...patientMetrics);
        if (!options.personal && !query.operatorId && !query.eventTypeId && !filters.status && !filters.patientId && !filters.query && filters.hour < 0 && filters.weekday < 0) {
            const registered = await Patient.schema(req.tenantSchema!).findAll({where: {structureId: {[Op.in]: scope.selectedStructureIds}, archivedAt: null}, attributes: ['createdAt'] as any});
            const dates = registered.map(patient => patient.get('createdAt') as unknown).filter(Boolean).map(value => dateOnly(value));
            const newRegistered = item('registeredNew', 'Nuove anagrafiche', dates.filter(date => date >= query.from && date <= query.to).length, 'number', 'Data di creazione dell’anagrafica nelle sedi selezionate, fra quelle oggi non archiviate');
            if (priorQuery) {newRegistered.previousValue = dates.filter(date => date >= priorQuery.from && date <= priorQuery.to).length; newRegistered.change = percentageChange(newRegistered.value!, newRegistered.previousValue);}
            summary.push(newRegistered, item('registeredTotal', 'Anagrafiche attuali', registered.length, 'number', 'Situazione attuale nelle sedi selezionate'));
        }
        const series = [['completed', 'Effettuate'], ['cancelled', 'Disdette'], ['noShow', 'Assenze'], ['confirmed', 'Programmate']].map(([key, label]) =>
            ({key, label, points: activity.series.map(point => ({label: point.bucket, value: (point as any)[key]}))}));
        return {meta, summary, columns: [col('bucket', 'Periodo', 'text'), col('completed', 'Effettuate'), col('cancelled', 'Disdette'), col('noShow', 'Assenze'), col('confirmed', 'Programmate')],
            ...paginateReport(activity.series.map(row => ({id: row.bucket, ...row})), page, size, options.allRows), series};
    }
    if (dataset === 'operators') {
        const finance = await loadFinanceData(scopedReq, {...query, ...parseFinanceFilters({...scopedReq, query: {}} as Request)}, scope);
        const revenue = new Map<string, number>(); let unassignedRevenue = 0;
        for (const invoice of finance.invoices) {
            const date = dateOnly(invoice.emissionDate);
            if (!validIssuedDocument(invoice) || date < query.from || date > query.to || !finance.attributableInvoiceIds.has(invoice.id)) continue;
            if (finance.scopeCompleteInvoiceIds && !finance.scopeCompleteInvoiceIds.has(invoice.id)) {
                unassignedRevenue += documentSign(invoice) * Number(invoice.invoiceTotal ?? 0);
                continue;
            }
            const owners = [...new Set(finance.events.filter(event => event.invoiceId === invoice.id || event.id === invoice.agendaEventId).map(event => event.calendarId ?? null))];
            const amount = documentSign(invoice) * Number(invoice.invoiceTotal ?? 0);
            if (owners.length === 1 && owners[0]) revenue.set(owners[0], (revenue.get(owners[0]) ?? 0) + amount);
            else unassignedRevenue += amount;
        }
        const missingIds = [...revenue.keys()].filter(id => !names.has(id));
        const missingUsers = missingIds.length ? await User.findAll({where: {id: {[Op.in]: missingIds}}, attributes: ['id', 'name', 'surname']}) : [];
        const output: Array<Record<string, any>> = activity.operators.map(row => ({id: row.operatorId, ...row, attributedRevenue: round(revenue.get(row.operatorId) ?? 0)}));
        for (const user of missingUsers) output.push({id: user.id, operatorId: user.id, operatorName: [user.name, user.surname].filter(Boolean).join(' '), completed: 0, cancelled: 0, noShow: 0, deliveredMinutes: 0, utilizationRate: null, attributedRevenue: round(revenue.get(user.id) ?? 0)});
        if (unassignedRevenue) summary.push(item('unassignedRevenue', 'Fatturato non attribuibile', round(unassignedRevenue), 'currency'));
        meta.warnings.push({code: 'CAPACITY_CURRENT_SCHEDULE', message: 'Utilizzo basato sugli orari configurati oggi. Fatturato per data emissione; documenti misti non ripartiti.'});
        return {meta, summary, columns: [col('operatorName', 'Professionista', 'text'), col('completed', 'Effettuate'), col('cancelled', 'Disdette'), col('noShow', 'Assenze'), col('deliveredMinutes', 'Minuti erogati'), col('utilizationRate', 'Utilizzo %', 'percent'), col('attributedRevenue', 'Fatturato attribuito', 'currency')],
            ...paginateReport(output.sort((a, b) => b.completed - a.completed || a.id.localeCompare(b.id)), page, size, options.allRows)};
    }
    if (dataset === 'services') {
        const data = await loadFinanceData(scopedReq, {...query, ...parseFinanceFilters({...scopedReq, query: {}} as Request)}, scope);
        const invoices = data.invoices.filter(invoice => validIssuedDocument(invoice) && data.attributableInvoiceIds.has(invoice.id) && dateOnly(invoice.emissionDate) >= query.from && dateOnly(invoice.emissionDate) <= query.to);
        const invoiceIds = invoices.map(invoice => invoice.id), byInvoice = new Map(invoices.map(invoice => [invoice.id, invoice]));
        const [products, services] = invoiceIds.length ? await Promise.all([
            InvoiceProduct.schema(req.tenantSchema!).findAll({where: {InvoiceId: {[Op.in]: invoiceIds}}}),
            InvoiceService.schema(req.tenantSchema!).findAll({where: {InvoiceId: {[Op.in]: invoiceIds}}})
        ]) : [[], []];
        const lines: Array<Record<string, any>> = [...products.map(row => ({...plain(row), kind: 'PRODUCT'})), ...services.map(row => ({...plain(row), kind: 'SERVICE'}))];
        const subtotals = new Map<string, number>();
        lines.forEach(line => subtotals.set(line.InvoiceId, (subtotals.get(line.InvoiceId) ?? 0) + Number(line.totalPrice ?? 0)));
        const billed = new Map<string, Record<string, any>>();
        for (const line of lines) {
            const invoice = byInvoice.get(line.InvoiceId)!, id = `${line.kind}:${line.ProductId ?? line.ServiceId ?? line.productName ?? line.serviceName}`;
            const row = billed.get(id) ?? {id: `billed:${id}`, section: 'Catalogo fatturato', eventTypeName: line.productName ?? line.serviceName ?? 'Voce senza nome', quantity: 0, netRevenue: 0};
            row.quantity += documentSign(invoice) * Number(line.quantity ?? 0);
            row.netRevenue += documentSign(invoice) * Number(line.totalPrice ?? 0) * documentDiscountRatio(invoice.discSellingPrice, subtotals.get(line.InvoiceId));
            billed.set(id, row);
        }
        const output: Array<Record<string, any>> = [...activity.eventTypes.map(row => ({id: row.eventTypeId ?? `legacy:${row.eventTypeName}`, section: 'Prestazioni erogate', ...row}))
            .sort((a, b) => b.completed - a.completed || a.id.localeCompare(b.id)),
            ...[...billed.values()].map<Record<string, any>>(row => ({...row, quantity: round(row.quantity), netRevenue: round(row.netRevenue)})).sort((a, b) => b.netRevenue - a.netRevenue || a.id.localeCompare(b.id))];
        meta.dateBasis = 'appointment_and_issue'; meta.warnings.push({code: 'CATALOG_DATE_BASES', message: 'Prestazioni per data seduta; catalogo per data emissione, sconti documento ripartiti e note di credito sottratte. Le due sezioni non si sommano.'});
        return {meta, summary, columns: [col('section', 'Sezione', 'text'), col('eventTypeName', 'Prestazione / voce', 'text'), col('completed', 'Effettuate'), col('cancelled', 'Disdette'), col('noShow', 'Assenze'), col('deliveredMinutes', 'Minuti erogati'), col('quantity', 'Quantità fatturata'), col('netRevenue', 'Valore netto fatturato', 'currency')],
            ...paginateReport(output, page, size, options.allRows)};
    }
    const slots = new Map<string, {id: string; weekday: number; hour: number; slot: string; completed: number; cancelled: number; noShow: number; unresolved: number; cancelledMinutes: number; noShowMinutes: number}>();
    const days = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'];
    rows.forEach(row => {
        const day = weekday(row.start), hour = Math.floor(localMinute(row.start) / 60), key = `${day}:${String(hour).padStart(2, '0')}`;
        const value = slots.get(key) ?? {id: key, weekday: day, hour, slot: `${days[day]} ${String(hour).padStart(2, '0')}:00`, completed: 0, cancelled: 0, noShow: 0, unresolved: 0, cancelledMinutes: 0, noShowMinutes: 0};
        if (row.status === 'COMPLETED') value.completed++;
        if (row.status === 'CANCELLED') {value.cancelled++; value.cancelledMinutes += row.durationMinutes;}
        if (row.status === 'NO_SHOW') {value.noShow++; value.noShowMinutes += row.durationMinutes;}
        if (row.status === 'CONFIRMED' && row.end < now) value.unresolved++;
        slots.set(key, value);
    });
    const output = [...slots.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour).map(row => {const denominator = row.completed + row.cancelled + row.noShow;
        return {...row, resolved: denominator, cancellationRate: denominator ? round(row.cancelled / denominator * 100) : null, noShowRate: denominator ? round(row.noShow / denominator * 100) : null,
            drilldown: {dataset: 'sessions', filters: {weekday: row.weekday, hour: row.hour}}};});
    meta.warnings.push({code: 'SCHEDULED_TIME', message: 'Le fasce si riferiscono alla data e all’ora previste della seduta, non al momento della disdetta.'});
    return {meta, summary, columns: [col('slot', 'Giorno e fascia', 'text'), col('resolved', 'Sedute con esito'), col('cancelled', 'Disdette'), col('cancellationRate', 'Disdette %', 'percent'), col('noShow', 'Assenze'), col('noShowRate', 'Assenze %', 'percent'), col('unresolved', 'Da verificare'), col('cancelledMinutes', 'Minuti disdetti'), col('noShowMinutes', 'Minuti assenze')], ...paginateReport(output, page, size, options.allRows)};
}

/** Convert a local wall-clock minute to an instant, respecting Rome's current offset. */
function zonedMinute(date: string, minute: number): number {
    const target = Date.parse(date + 'T00:00:00Z') + minute * 60000;
    let result = target;
    for (let pass = 0; pass < 3; pass++) {
        const value = new Date(result);
        const represented = Date.parse(localDateKey(value) + 'T00:00:00Z') + localMinute(value) * 60000;
        result += target - represented;
    }
    return result;
}
async function capacityDataset(req: Request, query: AnalyticsQuery, scope: ReportScope, meta: ReportMeta, page: number, size: number, allRows: boolean, now: Date): Promise<ReportDatasetResponse> {
    meta.dateBasis = 'future_appointment'; meta.balanceAsOf = localDateKey(now); meta.comparisonPeriod = null;
    const columns = [col('date', 'Data', 'date'), col('operatorName', 'Professionista', 'text'), col('availableMinutes', 'Minuti disponibili'), col('occupiedMinutes', 'Minuti occupati'), col('freeMinutes', 'Minuti liberi'), col('utilizationRate', 'Occupazione %', 'percent'), col('overlapMinutes', 'Sovrapposizioni (min)'), col('outsideMinutes', 'Fuori orario (min)')];
    if (scope.selectedStructureIds.length !== 1) return {meta: {...meta, warnings: [{code: 'SELECT_STRUCTURE', message: 'Seleziona una sede per calcolare la disponibilità degli operatori.'}]}, summary: [], columns, ...paginateReport([], page, size, allRows)};
    if (query.from < localDateKey(now)) throw new AnalyticsQueryError('La programmazione richiede un intervallo da oggi in avanti');
    const structureId = scope.selectedStructureIds[0];
    const candidates = await StructureUser.findAll({where: {structureId, calendarEnabled: true, ...(query.operatorId ? {userId: query.operatorId} : {})}});
    const tenantMembers = candidates.length ? await TenantUser.findAll({where: {tenantId: scope.tenantId, userId: {[Op.in]: candidates.map(row => row.userId)}, deactivatedAt: null}, attributes: ['userId']}) : [];
    const users = tenantMembers.length ? await User.findAll({where: {id: {[Op.in]: tenantMembers.map(row => row.userId)}, deactivatedAt: null}, attributes: ['id', 'name', 'surname']}) : [];
    const ids = users.map(row => row.id);
    const memberships = candidates.filter(member => ids.includes(member.userId));
    if (!ids.length) return {meta, summary: [], columns, ...paginateReport([], page, size, allRows)};
    const [personal, opening, absences, appointments] = await Promise.all([
        StructureUserAvailability.findAll({where: {structureId, userId: {[Op.in]: ids}}}),
        StructureAvailability.findAll({where: {structureId}}),
        TimeOffRequest.schema(req.tenantSchema!).findAll({where: {structureId, userId: {[Op.in]: ids}, status: 'APPROVED'}}),
        // Capacity includes every appointment; a service filter does not make other bookings free.
        loadOccurrences(req.tenantSchema!, {...query, eventTypeId: null}, true)
    ]);
    if (query.eventTypeId) meta.warnings.push({code: 'CAPACITY_ALL_SERVICES', message: 'L’occupazione include tutte le prestazioni del calendario selezionato.'});
    const names = new Map(users.map(user => [user.id, [user.name, user.surname].filter(Boolean).join(' ')]));
    const output: Array<Record<string, any>> = [];
    for (let date = query.from; date <= query.to; date = addDays(date, 1)) {
        const day = (new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7;
        const start = Math.max(zonedMinute(date, 0), now.getTime()), end = zonedMinute(addDays(date, 1), 0);
        for (const member of memberships) {
            const schedule = member.availabilityMode === 'CUSTOM' ? personal.find(row => row.userId === member.userId && row.day === day) : opening.find(row => row.day === day);
            const available = schedule && plain(schedule).enabled ? rangesOfRow(plain(schedule)).map(([a, b]): Interval => [Math.max(zonedMinute(date, a), start), Math.min(zonedMinute(date, b), end)]).filter(([a, b]) => b > a) : [];
            const timeOff = [...absences.filter(row => row.userId === member.userId).map(row => [new Date(row.start).getTime(), new Date(row.end).getTime()] as Interval),
                ...appointments.filter(row => row.calendarId === member.userId && ['Ferie', 'Permesso'].includes(row.title ?? '') && row.status !== 'CANCELLED').map(row => [row.start.getTime(), row.end.getTime()] as Interval)];
            const bookings = appointments.filter(row => row.calendarId === member.userId && !['Ferie', 'Permesso'].includes(row.title ?? '') && row.status === 'CONFIRMED' && row.start.getTime() < end && row.end.getTime() > start)
                .map(row => [Math.max(row.start.getTime(), start), Math.min(row.end.getTime(), end)] as Interval);
            output.push({id: `${member.userId}:${date}`, structureId, operatorId: member.userId, operatorName: names.get(member.userId) ?? 'Professionista', date, ...capacityValues(available, timeOff, bookings)});
        }
    }
    const sum = (key: string) => round(output.reduce((total, row) => total + row[key], 0));
    const available = sum('availableMinutes'), occupied = sum('occupiedMinutes');
    const summary = [item('availableMinutes', 'Tempo disponibile', available, 'minutes'), item('occupiedMinutes', 'Tempo occupato', occupied, 'minutes'), item('freeMinutes', 'Tempo libero', sum('freeMinutes'), 'minutes'), item('utilizationRate', 'Occupazione futura', available ? round(occupied / available * 100) : null, 'percent'), item('overlapMinutes', 'Sovrapposizioni', sum('overlapMinutes'), 'minutes'), item('outsideMinutes', 'Prenotato fuori orario', sum('outsideMinutes'), 'minutes')];
    return {meta, summary, columns, ...paginateReport(output, page, size, allRows)};
}

async function followupDataset(req: Request, query: AnalyticsQuery, scope: ReportScope, meta: ReportMeta, page: number, size: number, allRows: boolean, now: Date): Promise<ReportDatasetResponse> {
    const threshold = integer(req, 'thresholdDays', 30, 1, 735), today = localDateKey(now);
    meta.balanceAsOf = today; meta.comparisonPeriod = null; meta.effectiveFilters = {...meta.effectiveFilters, thresholdDays: threshold, lookbackDays: integer(req, 'lookbackDays', 180, 1, 735)};
    const history = (await loadOccurrences(req.tenantSchema!, query)).filter(row => row.status === 'COMPLETED' && row.patientId && row.start <= now);
    const latest = new Map<string, ReportOccurrence>();
    history.forEach(row => {if (!latest.has(row.patientId!) || row.start > latest.get(row.patientId!)!.start) latest.set(row.patientId!, row);});
    const patientIds = [...latest.keys()];
    const patients = patientIds.length ? await Patient.schema(req.tenantSchema!).findAll({where: {id: {[Op.in]: patientIds}, structureId: {[Op.in]: scope.selectedStructureIds}, archivedAt: null}, attributes: ['id', 'name', 'surname']}) : [];
    const candidates = new Set(patients.map(patient => patient.id));
    const future = candidates.size ? await AgendaEvent.schema(req.tenantSchema!).findAll({where: {patientId: {[Op.in]: [...candidates]}, structureId: {[Op.in]: scope.selectedStructureIds}, status: 'CONFIRMED', ...(query.operatorId ? {calendarId: query.operatorId} : {}), ...(query.eventTypeId ? {eventTypeId: query.eventTypeId} : {})}}) : [];
    const masters = future.filter(event => event.recurrence).map(event => event.id);
    const exceptions = masters.length ? await AgendaEventException.schema(req.tenantSchema!).findAll({where: {eventId: {[Op.in]: masters}}}) : [];
    const next = new Map<string, Date>();
    for (const event of future) {
        let date: Date | null = event.start ? new Date(event.start) : null;
        if (event.recurrence && date && Number.isFinite(date.getTime())) {
            try {
                const until = event.end ? new Date(event.end) : null;
                const ruleText = String(event.recurrence).split(';').filter(part => !part.startsWith('UNTIL='));
                if (until && Number.isFinite(until.getTime())) ruleText.push('UNTIL=' + until.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''));
                const rule = rrulePackage.rrulestr('DTSTART:' + date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '') + '\nRRULE:' + ruleText.join(';'));
                const excluded = new Set(exceptions.filter(value => value.eventId === event.id).map(value => Date.parse(value.exdate!)));
                date = rule.after(now, true);
                while (date && excluded.has(date.getTime())) date = rule.after(date, false);
            } catch {meta.warnings.push({code: 'INVALID_RECURRENCE', message: 'Una serie non valida impedisce di verificare la prossima prenotazione.'}); candidates.delete(event.patientId!); continue;}
        }
        if (date && Number.isFinite(date.getTime()) && date >= now && (!next.has(event.patientId!) || date < next.get(event.patientId!)!)) next.set(event.patientId!, date);
    }
    const selected = patients.filter(patient => candidates.has(patient.id) && followupEligible(localDateKey(latest.get(patient.id)!.start), today, threshold, next.get(patient.id)?.toISOString() ?? null));
    const ids = selected.map(patient => patient.id);
    const [protocolScope, grantedPackageScope] = await Promise.all([
        resolveOptionalReportScope(req, scope, 'protocol'), resolveOptionalReportScope(req, scope, 'quote')
    ]);
    // Packages do not expose a reliable ownership field; an own-only grant cannot disclose them.
    const packageScope = grantedPackageScope === 'own' ? null : grantedPackageScope;
    const [protocols, packages] = await Promise.all([
        ids.length && protocolScope ? ProtocolInstance.schema(req.tenantSchema!).findAll({where: {patientId: {[Op.in]: ids}, ...(protocolScope === 'own' ? {userId: scope.userId} : {})}, attributes: ['patientId', 'status', 'endDate']}) : [],
        ids.length && packageScope ? CarePackage.schema(req.tenantSchema!).findAll({where: {patientId: {[Op.in]: ids}, structureId: {[Op.in]: scope.selectedStructureIds}, status: 'ACTIVE', remainingUnits: {[Op.gt]: 0}}}) : []
    ]);
    const output = selected.map(patient => {
        const last = latest.get(patient.id)!;
        const patientProtocols = protocols.filter(protocol => protocol.patientId === patient.id);
        const usablePackages = packages.map(plain).filter(pack => pack.patientId === patient.id && (!pack.expiresAt || String(pack.expiresAt).slice(0, 10) >= today));
        return {id: patient.id, sourceId: patient.id, targetType: 'patient', patientId: patient.id,
            patientName: [patient.name, patient.surname].filter(Boolean).join(' '), lastAppointmentAt: last.start.toISOString(),
            daysSinceLast: Math.round((Date.parse(today + 'T12:00:00Z') - Date.parse(localDateKey(last.start) + 'T12:00:00Z')) / 86400000),
            nextAppointmentAt: null, lastAppointmentId: last.sourceEventId, title: last.title, structureId: last.structureId,
            ...(protocolScope ? {activeProtocols: patientProtocols.filter(protocol => protocol.status === 'ACTIVE').length, completedProtocols: patientProtocols.filter(protocol => protocol.status === 'COMPLETED').length, suspendedProtocols: patientProtocols.filter(protocol => protocol.status === 'SUSPENDED').length} : {}),
            ...(packageScope ? {remainingPackageUnits: round(usablePackages.reduce((sum, pack) => sum + Number(pack.remainingUnits), 0))} : {})};
    }).filter(row => (!req.query.patientId || row.patientId === optionalId(req, 'patientId')) && (!req.query.query || row.patientName.toLocaleLowerCase('it').includes(String(req.query.query).toLocaleLowerCase('it'))))
        .sort((a, b) => b.daysSinceLast - a.daysSinceLast || a.id.localeCompare(b.id));
    meta.warnings.push({code: 'NO_CLINICAL_STATE_INFERENCE', message: 'Nessuna futura prenotazione nel contesto visibile. Protocolli e pacchetti sono evidenze registrate, non attestano un percorso attivo o una dimissione.'});
    const columns = [col('patientName', 'Paziente', 'text'), col('lastAppointmentAt', 'Ultima effettuata', 'datetime'), col('daysSinceLast', 'Giorni trascorsi'), col('title', 'Ultima prestazione', 'text')];
    if (protocolScope) columns.push(col('activeProtocols', 'Protocolli registrati attivi'), col('completedProtocols', 'Protocolli completati'), col('suspendedProtocols', 'Protocolli sospesi'));
    if (packageScope) columns.push(col('remainingPackageUnits', 'Unità pacchetto utilizzabili'));
    return {meta, summary: [item('candidates', 'Pazienti senza prossima prenotazione', output.length), item('thresholdDays', 'Soglia senza sedute', threshold, 'number', 'Giorni dall’ultima seduta completata')], columns, ...paginateReport(output, page, size, allRows)};
}

import { Request } from 'express';
import {appointmentBalanceIssues, withFinancialDiagnosticDrilldowns} from './financialDiagnostics.service.js';
import {unassignedFinancialWarnings} from './financialDiagnosticSelectors.service.js';
export {unassignedFinancialWarnings} from './financialDiagnosticSelectors.service.js';
import { Op } from 'sequelize';
import { Expense, PaymentMethod, TreasuryMovement } from '../../administration/models/index.js';
import Patient from '../../patients/models/patient.model.js';
import { balanceEffectiveMovements } from '../../administration/services/treasuryLedger.service.js';
import {economicMovements} from '../../administration/services/financialMovementPolicy.service.js';
import { summarizeInvoicePayments } from '../../invoice/services/payment.service.js';
import { aggregateFinance, FinanceQuery, financialSelection, loadFinanceData, money, parseFinanceFilters } from './finance.service.js';
import { comparisonRange, parseAnalyticsQuery, percentageChange } from './analytics.service.js';
import { dateOnly, documentSign, FinancialWarning, inFinancialPeriod, validIssuedDocument } from './financialFacts.service.js';
import { reportStructureWhere, ReportScope, resolveReportScope } from './reportScope.service.js';
import { paginateReport, ReportColumn, ReportDatasetResponse, ReportSummaryItem } from './reporting.types.js';

type Row = Record<string, any>;
export const FINANCIAL_DATASETS = ['financial-summary', 'documents', 'payments', 'treasury', 'expenses', 'receivables'] as const;
const plain = (row: any): Row => typeof row.get === 'function' ? row.get({ plain: true }) : row;
const sum = (rows: Row[], field: string) => money(rows.reduce((total, row) => total + Number(row[field] ?? 0), 0));
const fail = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const currency = (key: string, label: string, value: number, description?: string): ReportSummaryItem => ({ key, label, value, format: 'currency', description });
const col = (key: string, label: string, type: ReportColumn['type'] = 'text'): ReportColumn => ({ key, label, type });

export function treasuryProjection(movements: Row[], expenses: Row[], from: string, to: string, filters: { accountId?: string | null; category?: string | null; paymentMethodIds?: Array<string | null>; direction?: string | null } = {}) {
    const rows = balanceEffectiveMovements(movements).filter(row => inFinancialPeriod(row.occurredAt, from, to)
        && (!filters.accountId || row.accountId === filters.accountId) && (!filters.category || row.category === filters.category)
        && (!filters.paymentMethodIds || filters.paymentMethodIds.includes(row.paymentMethodId ?? null))
        && (!filters.direction || row.direction === filters.direction));
    const costs = expenses.filter(row => inFinancialPeriod(row.incurredAt, from, to)
        && !['VOID', 'CANCELLED'].includes(String(row.status).toUpperCase()) && (!filters.category || row.category === filters.category));
    const economic = economicMovements(rows);
    const income = sum(economic.filter(row => row.direction === 'IN'), 'amount');
    const outcome = sum(economic.filter(row => row.direction === 'OUT'), 'amount');
    return { rows, costs, income, outcome, cashFlow: money(income - outcome), expenses: sum(costs, 'amount'),
        advances: money(sum(rows.filter(row => row.direction === 'IN' && row.sourceType === 'PATIENT_ADVANCE'), 'amount')
            - sum(rows.filter(row => row.direction === 'OUT' && row.sourceType === 'PATIENT_ADVANCE_VOID'), 'amount')),
        creditRefunds: money(sum(rows.filter(row => row.direction === 'OUT' && row.sourceType === 'PATIENT_CREDIT_REFUND'), 'amount')
            - sum(rows.filter(row => row.direction === 'IN' && row.sourceType === 'PATIENT_REFUND_VOID'), 'amount')) };
}

/** Shared projection for the existing administrative report and overview. */
export function administrationFinancialProjection(documents: Row[], movements: Row[], expenses: Row[], structures: Row[], from: string, to: string) {
    const docs = documents.filter(row => validIssuedDocument(row) && inFinancialPeriod(row.emissionDate, from, to));
    const issued = money(docs.reduce((total, row) => total + documentSign(row) * Number(row.invoiceTotal ?? 0), 0));
    const treasury = treasuryProjection(movements, expenses, from, to);
    const categories = ['fattura', 'ricevuta', 'nota_di_credito'].map(type => ({
        label: type === 'nota_di_credito' ? 'Note di credito' : type === 'ricevuta' ? 'Ricevute' : 'Fatture',
        value: money(docs.filter(row => (row.documentType || 'fattura') === type)
            .reduce((total, row) => total + documentSign(row) * Number(row.invoiceTotal ?? 0), 0))
    })).filter(row => row.value !== 0);
    const series: Row[] = [];
    for (let day = new Date(`${from.slice(0, 7)}-01T12:00:00Z`); day <= new Date(`${to}T12:00:00Z`); day.setUTCMonth(day.getUTCMonth() + 1)) {
        const key = day.toISOString().slice(0, 7);
        const cash = economicMovements(treasury.rows).filter(row => dateOnly(row.occurredAt).startsWith(key));
        const income = sum(cash.filter(row => row.direction === 'IN'), 'amount');
        const outcome = sum(cash.filter(row => row.direction === 'OUT'), 'amount');
        series.push({ label: new Intl.DateTimeFormat('it-IT', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(day),
            issued: money(docs.filter(row => dateOnly(row.emissionDate).startsWith(key)).reduce((total, row) => total + documentSign(row) * Number(row.invoiceTotal ?? 0), 0)),
            collected: income, income, outcome, cashFlow: money(income - outcome),
            expenses: sum(treasury.costs.filter(row => dateOnly(row.incurredAt).startsWith(key)), 'amount') });
    }
    return { period: { from, to }, generatedAt: new Date().toISOString(), balanceAsOf: dateOnly(new Date()),
        issued, collected: treasury.income, income: treasury.income, outcome: treasury.outcome, cashFlow: treasury.cashFlow,
        expenses: treasury.expenses, advances: treasury.advances, creditRefunds: treasury.creditRefunds,
        // Deprecated alias retained for clients migrating to cashFlow. It no longer mixes expenses and cash.
        margin: treasury.cashFlow, series, categories: categories.map(row => ({ ...row, percentage: null })),
        structures: structures.map(structure => {
            const selectedDocs = docs.filter(row => row.structureId === structure.id);
            const cash = treasuryProjection(movements.filter(row => row.structureId === structure.id), expenses.filter(row => row.structureId === structure.id), from, to);
            return { name: structure.name, issued: money(selectedDocs.reduce((total, row) => total + documentSign(row) * Number(row.invoiceTotal ?? 0), 0)),
                collected: cash.income, income: cash.income, outcome: cash.outcome, cashFlow: cash.cashFlow, expenses: cash.expenses,
                receivable: sum(selectedDocs, 'residualAmount') };
        }) };
}

export async function financialDataset(req: Request, dataset: string, options: { allRows?: boolean } = {}): Promise<ReportDatasetResponse> {
    if (!(FINANCIAL_DATASETS as readonly string[]).includes(dataset)) fail('Report finanziario non disponibile');
    const scope: ReportScope = (req as any).reportScope ?? await resolveReportScope(req, { resource: 'analytics', action: 'read' });
    const scopedRequest = Object.assign(Object.create(req), { reportScope: scope }) as Request;
    const query: FinanceQuery = { ...parseAnalyticsQuery(scopedRequest), ...parseFinanceFilters(req) };
    if (['accountId', 'category', 'direction', 'kind', 'dueBucket', 'overdue', 'receivableType', 'page', 'size']
        .some(key => req.query[key] != null && typeof req.query[key] !== 'string')) fail('Filtro del report non valido');
    if (query.statuses?.length || query.agendaEventIds) fail('I filtri delle singole sedute si applicano al report sedute');
    const contextual = !!(req.query.patientId || query.operatorId || query.eventTypeId || query.eventTypeIds?.length || (query.paymentMethod && dataset !== 'treasury')
        || query.paymentStatus !== 'all' || query.documentStatus !== 'all' || query.statuses?.length);
    if (contextual && ['treasury', 'expenses'].includes(dataset)) fail('I filtri clinici non si applicano alla tesoreria o alle spese');
    const accountId = req.query.accountId ? String(req.query.accountId) : null;
    const category = req.query.category ? String(req.query.category) : null;
    const direction = req.query.direction ? String(req.query.direction) : null;
    const kind = req.query.kind ? String(req.query.kind) : null;
    if (kind && (dataset !== 'payments' || !['receipt', 'reversal', 'refund'].includes(kind))) fail('Tipo movimento non valido per questo report');
    if (req.query.receivableType && (dataset !== 'receivables' || !['invoice', 'appointment', 'package'].includes(String(req.query.receivableType)))) fail('Tipo residuo non valido');
    if ((req.query.dueBucket || req.query.overdue) && dataset !== 'receivables') fail('Il filtro scadenza si applica solo ai residui');
    if (req.query.query != null && (typeof req.query.query !== 'string' || req.query.query.length > 255)) fail('Ricerca non valida');
    const search = String(req.query.query ?? '').trim().toLocaleLowerCase('it');
    if (search && !['documents', 'payments', 'receivables'].includes(dataset)) fail('La ricerca si applica a documenti, incassi e residui');
    const matchesSearch = (row: Row) => !search || [row.patient, row.description, row.number, row.method, row.origin]
        .filter(Boolean).join(' ').toLocaleLowerCase('it').includes(search);
    if (direction && (!['IN', 'OUT'].includes(direction) || dataset !== 'treasury')) fail('Direzione non valida per questo report');
    if ((accountId || category) && !['treasury', 'expenses'].includes(dataset)) fail('Conto e categoria si applicano solo a tesoreria e spese');
    if (accountId && dataset !== 'treasury') fail('Il filtro conto si applica solo alla tesoreria');
    if (accountId && !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(accountId)) fail('Conto non valido');
    const page = Number(req.query.page ?? 1), size = Number(req.query.size ?? 25);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(size) || size < 1 || size > 200) fail('Paginazione non valida');
    const needClinic = !['treasury', 'expenses'].includes(dataset);
    const needTreasury = ['treasury', 'expenses', 'financial-summary'].includes(dataset) && !contextual;
    const [data, movementModels, expenseModels] = await Promise.all([
        needClinic ? loadFinanceData(scopedRequest, query, scope) : null,
        needTreasury ? TreasuryMovement.schema(req.tenantSchema!).findAll({ where: reportStructureWhere(scope) }) : [],
        needTreasury ? Expense.schema(req.tenantSchema!).findAll({ where: reportStructureWhere(scope) }) : []
    ]);
    const movements = movementModels.map(plain), expenses = expenseModels.map(plain);
    let paymentMethodIds: Array<string | null> | undefined;
    if (query.paymentMethod && dataset === 'treasury') {
        paymentMethodIds = query.paymentMethod === '__unspecified__' ? [null] : (await PaymentMethod.schema(req.tenantSchema!).findAll({
            where: /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(query.paymentMethod) ? { id: query.paymentMethod } : { label: query.paymentMethod }
        })).map(row => String(row.get('id')));
    }
    const treasury = treasuryProjection(movements, expenses, query.from, query.to, { accountId, category, paymentMethodIds, direction });
    const finance = data ? aggregateFinance(data, query) : null;
    const selected = data ? financialSelection(data, query) : null;
    const patients = data ? [...new Set([...data.invoices.map(row => row.patientID), ...data.events.map(row => row.patientId), ...(data.packages ?? []).map(row => row.patientId)].filter(Boolean))] : [];
    const patientModels = patients.length ? await Patient.schema(req.tenantSchema!).findAll({ where: { id: { [Op.in]: patients } }, attributes: ['id', 'name', 'surname'] }) : [];
    const names = new Map(patientModels.map(plain).map(row => [row.id, `${row.name ?? ''} ${row.surname ?? ''}`.trim()]));
    const structures = new Map(scope.structures.map(row => [row.id, row.name]));
    const warnings: FinancialWarning[] = [...(data?.warnings ?? []), ...await unassignedFinancialWarnings(req, scope, query.from, query.to, dataset)];
    if (data?.excludedMixedInvoiceCount) warnings.push({ code: 'mixed-documents', count: data.excludedMixedInvoiceCount,
        message: 'Documenti con prestazioni appartenenti a contesti diversi esclusi dall’attribuzione.' });
    if (contextual && dataset === 'financial-summary') warnings.push({ code: 'clinical-context', message: 'Tesoreria e spese non sono attribuite ai filtri clinici e non compaiono in questo riepilogo.' });
    if (selected && ['financial-summary', 'receivables'].includes(dataset)) {
        const obligations = appointmentBalanceIssues(selected).map(({financial}) => financial);
        const unknown = obligations.filter(financial => financial.paymentStatus === 'unknown').length;
        const estimated = obligations.filter(financial => financial.priceEstimated && Number(financial.balance) > 0).length;
        if (unknown) warnings.push({ code: 'unknown-appointment-balances', count: unknown,
            message: 'Sedute con saldo non determinabile: escluse dal residuo, senza considerarle saldate.' });
        if (estimated) warnings.push({ code: 'estimated-appointment-balances', count: estimated,
            message: 'Residui di sedute calcolati su una tariffa stimata, identificati nel dettaglio.' });
    }
    let rows: Row[] = [], columns: ReportColumn[] = [], summary: ReportSummaryItem[] = [];
    let dateBasis = 'current';
    const documentRows = (selection = selected!) => selection.issued.map(row => ({ sourceId: row.id, targetType: 'invoice', structureId: row.structureId,
        number: row.documentNumber == null ? 'Senza numero' : `${row.documentNumber}/${row.documentYear ?? ''}`,
        date: dateOnly(row.emissionDate), patient: names.get(row.patientID) ?? 'Paziente non disponibile',
        structure: structures.get(row.structureId) ?? 'Sede non disponibile', documentType: row.documentType,
        amount: money(documentSign(row) * Number(row.invoiceTotal ?? 0)), payable: money(documentSign(row) * Number(row.invoiceNet ?? row.invoiceTotal ?? 0)) })).filter(matchesSearch);
    const paymentRows = (selection = selected!) => selection.periodPayments.filter(row => !kind || row.kind === kind).map(row => {
        const invoice = data!.invoices.find(invoice => invoice.id === row.invoiceId);
        const event = data!.events.find(event => event.id === row.agendaEventId);
        const pkg = data!.packages?.find(pkg => pkg.id === row.carePackageId);
        return { id: row.id, sourceId: invoice?.id ?? pkg?.id ?? event?.id ?? row.sourceId, targetType: invoice ? 'invoice' : pkg ? 'package' : event ? 'appointment' : 'treasury',
            structureId: invoice?.structureId ?? pkg?.structureId ?? event?.structureId ?? null,
            structure: structures.get(invoice?.structureId ?? pkg?.structureId ?? event?.structureId) ?? 'Sede non disponibile',
            sourceEventId: event?.id, start: event?.start, occurrenceStart: event?.start,
            number: invoice?.documentNumber == null ? '' : `${invoice.documentNumber}/${invoice.documentYear ?? ''}`,
            date: dateOnly(row.paidAt), kind: ({ receipt: 'Incasso', reversal: 'Rettifica', refund: 'Rimborso' })[row.kind],
            patient: names.get(invoice?.patientID ?? pkg?.patientId ?? event?.patientId) ?? 'Paziente non disponibile', method: row.method ?? 'Non specificato',
            amount: row.amount, origin: row.source === 'PACKAGE_PURCHASE' ? 'Acquisto pacchetto' : row.source === 'APPOINTMENT' ? 'Seduta' : 'Documento' };
    }).filter(matchesSearch);
    if (dataset === 'financial-summary') {
        dateBasis = 'Emissione documenti; data incasso/rettifica; data movimento; spese sostenute. Residui attuali.';
        const totals = finance!.totals;
        summary = [currency('billedTotal', 'Emesso dopo rettifiche', totals.billedTotal),
            currency('collectedGross', 'Incassi clinici lordi', totals.collectedGross),
            currency('collectionReversals', 'Rettifiche incassi', totals.collectionReversals),
            currency('collectionRefunds', 'Rimborsi incassi clinici', totals.collectionRefunds),
            currency('collected', 'Incassi clinici netti', totals.collected),
            currency('outstanding', 'Residuo attuale', totals.outstanding, 'Saldo attuale, indipendente dal periodo selezionato'),
            currency('undatedLegacyPaid', 'Incassi senza data', totals.undatedLegacyPaid),
            currency('discounts', 'Sconti sui documenti', totals.discounts),
            currency('collectedFromAppointments', 'Incassi da sedute', totals.collectedFromAppointments),
            currency('collectedFromInvoices', 'Incassi da documenti', totals.collectedFromInvoices),
            currency('collectedFromPackages', 'Incassi da pacchetti', totals.collectedFromPackages),
            currency('collectedUnbilled', 'Incassi ancora da fatturare', totals.collectedUnbilled, 'Situazione attuale degli incassi senza documento'),
            currency('invoiceOutstanding', 'Residuo documenti', totals.invoiceOutstanding),
            currency('appointmentOutstanding', 'Residuo sedute', totals.appointmentOutstanding),
            currency('packageOutstanding', 'Residuo pacchetti', totals.packageOutstanding),
            currency('overdue', 'Residuo documenti scaduti', totals.overdue),
            currency('issuedOutstanding', 'Residuo dei documenti del periodo', totals.issuedOutstanding),
            {key: 'unbilledCompleted', label: 'Sedute effettuate da fatturare', value: totals.unbilledCompleted, format: 'number'},
            currency('unbilledEstimatedValue', 'Valore sedute da fatturare', totals.unbilledEstimatedValue, 'Prezzi noti, incluse tariffe stimate; prezzi mancanti esclusi')];
        if (needTreasury) summary.push(currency('income', 'Entrate di tesoreria', treasury.income), currency('outcome', 'Uscite di tesoreria', treasury.outcome),
            currency('cashFlow', 'Flusso netto di cassa', treasury.cashFlow), currency('advances', 'Anticipi ricevuti', treasury.advances),
            currency('creditRefunds', 'Rimborsi crediti pazienti', treasury.creditRefunds), currency('expenses', 'Spese sostenute', treasury.expenses));
        const drilldowns: Record<string, { dataset: string; filters: Record<string, unknown> }> = {
            billedTotal: { dataset: 'documents', filters: {} }, collected: { dataset: 'payments', filters: {} },
            collectedGross: { dataset: 'payments', filters: { kind: 'receipt' } }, collectionReversals: { dataset: 'payments', filters: { kind: 'reversal' } },
            collectionRefunds: { dataset: 'payments', filters: { kind: 'refund' } }, outstanding: { dataset: 'receivables', filters: {} },
            invoiceOutstanding: {dataset: 'receivables', filters: {receivableType: 'invoice'}},
            appointmentOutstanding: {dataset: 'receivables', filters: {receivableType: 'appointment'}},
            packageOutstanding: {dataset: 'receivables', filters: {receivableType: 'package'}},
            overdue: {dataset: 'receivables', filters: {dueBucket: 'overdue'}},
            unbilledCompleted: {dataset: 'sessions', filters: {status: 'COMPLETED', documentStatus: 'unbilled'}},
            unbilledEstimatedValue: {dataset: 'sessions', filters: {status: 'COMPLETED', documentStatus: 'unbilled'}},
            income: { dataset: 'treasury', filters: { direction: 'IN' } }, outcome: { dataset: 'treasury', filters: { direction: 'OUT' } },
            cashFlow: { dataset: 'treasury', filters: {} }, expenses: { dataset: 'expenses', filters: {} },
            advances: { dataset: 'treasury', filters: { category: 'PATIENT_ADVANCE', direction: 'IN' } },
            creditRefunds: { dataset: 'treasury', filters: { category: 'PATIENT_CREDIT_REFUND', direction: 'OUT' } }
        };
        for (const item of summary) if (drilldowns[item.key]) item.drilldown = drilldowns[item.key];
        const previousQuery = comparisonRange(query);
        if (previousQuery) {
            const previous = aggregateFinance(data!, { ...query, ...previousQuery }).totals as Row;
            const previousTreasury = treasuryProjection(movements, expenses, previousQuery.from, previousQuery.to) as Row;
            for (const item of summary) if (!['outstanding', 'undatedLegacyPaid', 'invoiceOutstanding', 'appointmentOutstanding', 'packageOutstanding', 'overdue', 'collectedUnbilled', 'issuedOutstanding'].includes(item.key)) {
                item.previousValue = previous[item.key] ?? previousTreasury[item.key] ?? 0;
                item.change = percentageChange(item.value ?? 0, item.previousValue ?? 0);
            }
        }
        rows = summary.map(item => ({ metric: item.label, amount: item.value, description: item.description ?? '' }));
        columns = [col('metric', 'Indicatore'), col('amount', 'Importo', 'currency'), col('description', 'Criterio')];
    } else if (dataset === 'documents') {
        dateBasis = 'emissionDate'; rows = documentRows();
        columns = [col('number', 'Documento'), col('date', 'Emissione', 'date'), col('patient', 'Paziente'), col('structure', 'Sede'), col('documentType', 'Tipo'), col('amount', 'Emesso', 'currency'), col('payable', 'Dovuto dal paziente', 'currency')];
        summary = [currency('issued', 'Emesso dopo rettifiche', sum(rows, 'amount'))];
    } else if (dataset === 'payments') {
        dateBasis = 'paidAt / occurredAt della rettifica o del rimborso';
        rows = paymentRows();
        columns = [col('date', 'Data', 'date'), col('kind', 'Operazione'), col('patient', 'Paziente'), col('structure', 'Sede'), col('origin', 'Origine'), col('number', 'Documento'), col('method', 'Metodo'), col('amount', 'Importo', 'currency')];
        summary = [currency('collected', 'Incassi clinici netti', sum(rows, 'amount'))];
    } else if (dataset === 'treasury') {
        dateBasis = 'occurredAt';
        rows = treasury.rows.map(row => ({ sourceId: row.id, targetType: 'treasury', structureId: row.structureId, date: row.occurredAt,
            structure: structures.get(row.structureId) ?? 'Sede non disponibile', description: row.description ?? '', category: row.category,
            direction: row.direction === 'IN' ? 'Entrata' : 'Uscita', amount: money(Number(row.amount) * (row.direction === 'IN' ? 1 : -1)) }));
        columns = [col('date', 'Data', 'datetime'), col('structure', 'Sede'), col('description', 'Descrizione'), col('category', 'Categoria'), col('direction', 'Direzione'), col('amount', 'Importo', 'currency')];
        summary = [currency('income', 'Entrate', treasury.income), currency('outcome', 'Uscite', treasury.outcome), currency('cashFlow', 'Flusso netto di cassa', treasury.cashFlow)];
    } else if (dataset === 'expenses') {
        dateBasis = 'incurredAt';
        rows = treasury.costs.map(row => ({ sourceId: row.id, targetType: 'expense', structureId: row.structureId, date: dateOnly(row.incurredAt),
            description: row.description ?? '', structure: structures.get(row.structureId) ?? 'Sede non disponibile', category: row.category ?? '', status: row.status, amount: money(row.amount) }));
        columns = [col('date', 'Sostenuta il', 'date'), col('description', 'Descrizione'), col('structure', 'Sede'), col('category', 'Categoria'), col('status', 'Stato'), col('amount', 'Importo', 'currency')];
        summary = [currency('expenses', 'Spese sostenute', sum(rows, 'amount'))];
    } else {
        dateBasis = 'current';
        rows = selected!.invoices.flatMap(invoice => {
            const balance = summarizeInvoicePayments(invoice, data!.payments.filter(row => row.invoiceId === invoice.id)).balance;
            return balance > 0 ? [{ sourceId: invoice.id, targetType: 'invoice', structureId: invoice.structureId, patient: names.get(invoice.patientID) ?? 'Paziente non disponibile',
                description: `Documento ${invoice.documentNumber ?? ''}/${invoice.documentYear ?? ''}`, dueDate: invoice.paymentTerms ?? null,
                overdue: !!invoice.paymentTerms && dateOnly(invoice.paymentTerms) < dateOnly(new Date()), amount: balance, amountBasis: 'Documento emesso' }] : [];
        });
        for (const event of selected!.events) {
            const financial = selected!.financialByEvent.get(event.id)!;
            if (event.invoiceId || event.appointmentPriceAdjustment === 'COMPLIMENTARY' || !financial.eligible || !(Number(financial.balance) > 0)) continue;
            rows.push({ sourceId: event.id, targetType: 'appointment', structureId: event.structureId, patient: names.get(event.patientId) ?? 'Paziente non disponibile',
                sourceEventId: event.id, start: event.start, occurrenceStart: event.start,
                description: event.title ?? 'Seduta da incassare', dueDate: null, overdue: false, amount: financial.balance,
                amountBasis: financial.priceEstimated ? 'Tariffa stimata' : 'Importo registrato' });
        }
        const dueBucket = String(req.query.dueBucket ?? (req.query.overdue === 'true' ? 'overdue' : 'all'));
        for (const pkg of selected!.packages.filter(pkg => !pkg.billed && pkg.balance > 0)) {
            rows.push({sourceId: pkg.id, targetType: 'package', structureId: pkg.structureId,
                patient: names.get(pkg.patientId) ?? 'Paziente non disponibile', description: pkg.name,
                dueDate: null, overdue: false, amount: pkg.balance, amountBasis: 'Acquisto pacchetto'});
        }
        if (!['all', 'overdue', 'today', 'next7', 'future', 'no_due'].includes(dueBucket)) fail('Filtro scadenza non valido');
        const today = dateOnly(new Date());
        const future = new Date(`${today}T12:00:00Z`); future.setUTCDate(future.getUTCDate() + 7);
        const next7 = dateOnly(future);
        rows = rows.filter(row => dueBucket === 'all' || dueBucket === 'no_due' && !row.dueDate
            || dueBucket === 'overdue' && row.overdue || dueBucket === 'today' && dateOnly(row.dueDate) === today
            || dueBucket === 'next7' && dateOnly(row.dueDate) > today && dateOnly(row.dueDate) <= next7
            || dueBucket === 'future' && dateOnly(row.dueDate) > next7);
        rows = rows.filter(row => !req.query.receivableType || row.targetType === req.query.receivableType).filter(matchesSearch);
        columns = [col('patient', 'Paziente'), col('description', 'Documento / seduta'), col('dueDate', 'Scadenza', 'date'), col('amount', 'Residuo attuale', 'currency'), col('amountBasis', 'Criterio importo')];
        summary = [currency('outstanding', 'Residuo attuale', sum(rows, 'amount')), { key: 'count', label: 'Posizioni', value: rows.length, format: 'number' }];
    }
    const comparison = dataset === 'receivables' ? null : comparisonRange(query);
    if (comparison && dataset !== 'financial-summary') {
        const previousSelection = data ? financialSelection(data, { ...query, ...comparison }) : null;
        const previousTreasury = treasuryProjection(movements, expenses, comparison.from, comparison.to, { accountId, category, paymentMethodIds, direction });
        const previous: Row = { ...previousTreasury,
            ...(dataset === 'documents' ? { issued: sum(documentRows(previousSelection!), 'amount') } : {}),
            ...(dataset === 'payments' ? { collected: sum(paymentRows(previousSelection!), 'amount') } : {}) };
        for (const item of summary) {
            item.previousValue = previous[item.key] ?? 0;
            item.change = percentageChange(item.value ?? 0, item.previousValue ?? 0);
        }
    }
    rows.sort((a, b) => String(a.date ?? a.dueDate ?? '').localeCompare(String(b.date ?? b.dueDate ?? ''))
        || String(a.sourceId ?? a.metric ?? '').localeCompare(String(b.sourceId ?? b.metric ?? '')) || String(a.id ?? '').localeCompare(String(b.id ?? '')));
    return { meta: { effectiveFilters: { ...query, structureIds: scope.selectedStructureIds, ...(accountId ? { accountId } : {}), ...(category ? { category } : {}),
        ...Object.fromEntries(['direction', 'kind', 'dueBucket', 'receivableType', 'patientId', 'query'].filter(key => req.query[key]).map(key => [key, req.query[key]])) },
        generatedAt: new Date().toISOString(), balanceAsOf: dateOnly(new Date()), dateBasis,
        comparisonPeriod: comparison, warnings: withFinancialDiagnosticDrilldowns(warnings, scopedRequest, query, scope, dataset) },
        summary, columns, ...paginateReport(rows, page, size, options.allRows),
        ...(dataset === 'financial-summary' ? { series: [
            { key: 'billedTotal', label: 'Emesso dopo rettifiche', points: finance!.series.map(row => ({ label: row.bucket, value: row.billedTotal })) },
            { key: 'collected', label: 'Incassi clinici netti', points: finance!.series.map(row => ({ label: row.bucket, value: row.collected })) },
            { key: 'collectedFromAppointments', label: 'Da sedute', points: finance!.series.map(row => ({ label: row.bucket, value: row.collectedFromAppointments })) },
            { key: 'collectedFromInvoices', label: 'Da documenti', points: finance!.series.map(row => ({ label: row.bucket, value: row.collectedFromInvoices })) },
            { key: 'collectedFromPackages', label: 'Da pacchetti', points: finance!.series.map(row => ({ label: row.bucket, value: row.collectedFromPackages })) }
        ] } : {}) };
}

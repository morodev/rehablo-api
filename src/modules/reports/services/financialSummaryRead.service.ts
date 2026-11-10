import type {Request} from 'express';
import {QueryTypes} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import type {ReportScope} from './reportScope.service.js';
import {getReportTransaction} from './reportReadContext.js';

export interface TreasurySummary {
    income: number; outcome: number; cashFlow: number; advances: number; creditRefunds: number; expenses: number;
}
const zero = (): TreasurySummary => ({income: 0, outcome: 0, cashFlow: 0, advances: 0, creditRefunds: 0, expenses: 0});
/** Live period aggregates. Reversal evidence is authorized but deliberately not date-filtered. */
export async function loadTreasurySummaries(req: Request, scope: ReportScope,
    periods: ReadonlyArray<{key: string; from: string; to: string}>): Promise<Map<string, TreasurySummary>> {
    if (!periods.length || !scope.selectedStructureIds.length) return new Map(periods.map(period => [period.key, zero()]));
    const schema = req.tenantSchema!;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Invalid report schema');
    const replacements: Record<string, unknown> = {structureIds: scope.selectedStructureIds};
    const periodValues = periods.map((period, index) => {
        replacements['key' + index] = period.key; replacements['from' + index] = period.from; replacements['to' + index] = period.to;
        return '(CAST(:key' + index + ' AS text), CAST(:from' + index + ' AS date), CAST(:to' + index + ' AS date))';
    }).join(',');
    const table = '"' + schema + '".treasury_movements';
    const economic = 'COALESCE(m."sourceType",\'\') NOT IN (\'TRANSFER_OUT\',\'TRANSFER_IN\',\'TRANSFER_VOID_OUT\',\'TRANSFER_VOID_IN\')';
    const sql = `WITH periods(key, start_day, end_day) AS (VALUES ${periodValues})
        SELECT p.key,
          COALESCE(SUM(m.amount) FILTER (WHERE m.direction='IN' AND ${economic}),0) AS income,
          COALESCE(SUM(m.amount) FILTER (WHERE m.direction='OUT' AND ${economic}),0) AS outcome,
          COALESCE(SUM(CASE WHEN m.direction='IN' AND m."sourceType"='PATIENT_ADVANCE' THEN m.amount
            WHEN m.direction='OUT' AND m."sourceType"='PATIENT_ADVANCE_VOID' THEN -m.amount ELSE 0 END),0) AS advances,
          COALESCE(SUM(CASE WHEN m.direction='OUT' AND m."sourceType"='PATIENT_CREDIT_REFUND' THEN m.amount
            WHEN m.direction='IN' AND m."sourceType"='PATIENT_REFUND_VOID' THEN -m.amount ELSE 0 END),0) AS "creditRefunds",
          (SELECT COALESCE(SUM(e.amount),0) FROM "${schema}".expenses e
            WHERE e."structureId" IN (:structureIds) AND e."incurredAt" BETWEEN p.start_day AND p.end_day
              AND UPPER(COALESCE(e.status,'')) NOT IN ('VOID','CANCELLED')) AS expenses
        FROM periods p LEFT JOIN ${table} m
          ON m."structureId" IN (:structureIds)
          AND m."occurredAt" >= (p.start_day::timestamp AT TIME ZONE 'Europe/Rome')
          AND m."occurredAt" < ((p.end_day+1)::timestamp AT TIME ZONE 'Europe/Rome')
          AND (m.status='POSTED' OR (m.status='VOID' AND EXISTS (
            SELECT 1 FROM ${table} r WHERE r."structureId" IN (:structureIds)
              AND r.status='POSTED' AND r."reversalOfId"=m.id AND r."accountId" IS NOT DISTINCT FROM m."accountId"
              AND m.direction IN ('IN','OUT') AND r.direction IN ('IN','OUT') AND r.direction<>m.direction
              AND m.amount>0 AND ROUND(m.amount*100)=ROUND(r.amount*100))))
        GROUP BY p.key,p.start_day,p.end_day`;
    const rows = await sequelize.query<Record<string, unknown>>(sql, {
        type: QueryTypes.SELECT, replacements, transaction: getReportTransaction(req)
    });
    const round = (value: unknown) => Math.round(Number(value ?? 0) * 100) / 100;
    return new Map(rows.map(row => {
        const income = round(row.income), outcome = round(row.outcome);
        return [String(row.key), {income, outcome, cashFlow: round(income - outcome), advances: round(row.advances),
            creditRefunds: round(row.creditRefunds), expenses: round(row.expenses)}];
    }));
}

/** A compact financial read contract, never an agenda card or clinical/patient snapshot. */
export const SUMMARY_EVENT_ATTRIBUTES = [
    'id', 'structureId', 'calendarId', 'eventTypeId', 'patientId', 'start', 'status', 'recurrence', 'recurringEventId',
    'invoiceId', 'carePackageId', 'packageReservationStatus', 'appointmentPriceAdjustment',
    'appointmentExpectedAmount', 'appointmentNetAmount', 'appointmentVatRate', 'appointmentSocialSecurity',
    'appointmentPaidAmount', 'appointmentPaymentStatus', 'appointmentPaymentHistoryKnown', 'appointmentPaymentMethod', 'appointmentPaidAt'
];
export const SUMMARY_PACKAGE_ATTRIBUTES = [
    'id', 'structureId', 'patientId', 'templateId', 'quoteId', 'invoiceId', 'totalPrice', 'purchaseSnapshot', 'lines'
];

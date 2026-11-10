import {QueryTypes, Sequelize} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {AnalyticsQuery, AnalyticsQueryError, localDateKey} from './analytics.service.js';

export interface ReceivablesPage {
    totals: {outstanding: number; overdue: number; overdueCount: number; dueToday: number; dueTodayCount: number;
        dueNext7: number; dueNext7Count: number; noDueDate: number; noDueDateCount: number};
    pagination: {length: number; page: number; size: number; lastPage: number};
    invoices: Array<Record<string, any>>;
}

/** Current obligations are independent of the issue period. One SELECT keeps totals and page
 * on the same database snapshot and transfers only the requested rows. No materialized/cache state. */
export async function readReceivablesPage(schema: string, structureIds: readonly string[], query: AnalyticsQuery & {eventTypeIds?: readonly string[]; patientId?: unknown},
    page: number, size: number, bucket: string, database: Pick<Sequelize, 'query'> = sequelize,
    today = localDateKey(new Date())): Promise<ReceivablesPage> {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Invalid tenant schema');
    const contextual = !!(query.operatorId || query.eventTypeId);
    if (contextual && query.patientId && (typeof query.patientId !== 'string' || !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(query.patientId))) {
        throw new AnalyticsQueryError('Paziente non valido');
    }
    if (!structureIds.length) return {totals: {outstanding: 0, overdue: 0, overdueCount: 0, dueToday: 0,
        dueTodayCount: 0, dueNext7: 0, dueNext7Count: 0, noDueDate: 0, noDueDateCount: 0},
        pagination: {length: 0, page, size, lastPage: 1}, invoices: []};
    const prefix = `"${schema}"`;
    const children = contextual ? `,
        document_children AS (
            SELECT l."invoiceId", l."agendaEventId" FROM ${prefix}.invoice_agenda_events l
                JOIN candidate_invoices i ON i.id = l."invoiceId"
            UNION SELECT i.id, i."agendaEventId" FROM candidate_invoices i WHERE i."agendaEventId" IS NOT NULL
            UNION SELECT e."invoiceId", e.id FROM ${prefix}.agenda_events e
                JOIN candidate_invoices i ON i.id = e."invoiceId"
        ), authorized_invoices AS (
            SELECT i.* FROM candidate_invoices i
            WHERE EXISTS (SELECT 1 FROM document_children c WHERE c."invoiceId" = i.id)
              AND NOT EXISTS (
                SELECT 1 FROM document_children c LEFT JOIN ${prefix}.agenda_events e ON e.id = c."agendaEventId"
                WHERE c."invoiceId" = i.id AND (e.id IS NULL OR e."structureId" IS NULL
                    OR e."structureId" NOT IN (:structureIds)
                    ${query.operatorId ? 'OR e."calendarId" IS DISTINCT FROM CAST(:operatorId AS uuid)' : ''}
                    ${query.eventTypeId ? 'OR e."eventTypeId" IS DISTINCT FROM CAST(:eventTypeId AS uuid)' : ''}
                    ${query.eventTypeIds?.length ? 'OR e."eventTypeId" IS NULL OR e."eventTypeId" NOT IN (:eventTypeIds)' : ''})
              )
        )` : ', authorized_invoices AS (SELECT * FROM candidate_invoices)';
    const sql = `WITH candidate_invoices AS (
        SELECT id, "patientID", "structureId", "agendaEventId", "documentNumber", "documentYear", "documentType",
            "emissionDate", "paymentTerms", "invoiceTotal", "invoiceNet", status
        FROM ${prefix}.invoices
        WHERE "structureId" IN (:structureIds) AND status <> 'void' AND "documentType" <> 'nota_di_credito'
          AND "emissionDate" IS NOT NULL
          AND ("documentType" IS NULL OR "documentType" = '' OR "documentType" IN ('fattura', 'ricevuta', 'nota_di_credito'))
          AND LOWER(COALESCE(status, '')) NOT IN ('void', 'draft', 'cancelled')
          ${contextual && query.patientId ? 'AND "patientID" = CAST(:patientId AS uuid)' : ''}
    ) ${children}, payment_totals AS (
        SELECT p."invoiceId", COUNT(*) AS history_count,
            COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'POSTED'), 0) AS paid,
            BOOL_OR(p.status = 'POSTED' AND p.source = 'LEGACY_IMPORT' AND p."paidAt" IS NULL) AS undated_legacy
        FROM ${prefix}.invoice_payments p JOIN authorized_invoices i ON i.id = p."invoiceId"
        GROUP BY p."invoiceId"
    ), amounts AS (
        SELECT i.*, GREATEST(COALESCE(i."invoiceNet", i."invoiceTotal", 0), 0) AS payable,
            CASE WHEN COALESCE(p.history_count, 0) = 0 AND LOWER(i.status) = 'paid'
                THEN GREATEST(COALESCE(i."invoiceNet", i."invoiceTotal", 0), 0) ELSE COALESCE(p.paid, 0) END AS "paidAmount",
            ((COALESCE(p.history_count, 0) = 0 AND LOWER(i.status) = 'paid') OR COALESCE(p.undated_legacy, false)) AS "hasUndatedLegacyPayments"
        FROM authorized_invoices i LEFT JOIN payment_totals p ON p."invoiceId" = i.id
    ), balances AS (
        SELECT a.*, GREATEST(payable - "paidAmount", 0) AS balance FROM amounts a
    ), obligations AS (
        SELECT b.*, CASE WHEN "paidAmount" <= 0 THEN 'unpaid' WHEN balance > 0 THEN 'partial' ELSE 'paid' END AS "paymentStatus",
            CASE WHEN "paymentTerms" IS NULL THEN 'no_due' WHEN "paymentTerms" < CAST(:today AS date) THEN 'overdue'
                WHEN "paymentTerms" = CAST(:today AS date) THEN 'today'
                WHEN "paymentTerms" <= CAST(:today AS date) + 7 THEN 'next7' ELSE 'future' END AS "dueBucket",
            CASE WHEN "paymentTerms" < CAST(:today AS date) THEN CAST(:today AS date) - "paymentTerms" ELSE 0 END AS "daysOverdue"
        FROM balances b WHERE balance > 0
    ), totals AS (
        SELECT COALESCE(SUM(balance), 0) AS outstanding,
            COALESCE(SUM(balance) FILTER (WHERE "dueBucket" = 'overdue'), 0) AS overdue,
            COUNT(*) FILTER (WHERE "dueBucket" = 'overdue') AS "overdueCount",
            COALESCE(SUM(balance) FILTER (WHERE "dueBucket" = 'today'), 0) AS "dueToday",
            COUNT(*) FILTER (WHERE "dueBucket" = 'today') AS "dueTodayCount",
            COALESCE(SUM(balance) FILTER (WHERE "dueBucket" = 'next7'), 0) AS "dueNext7",
            COUNT(*) FILTER (WHERE "dueBucket" = 'next7') AS "dueNext7Count",
            COALESCE(SUM(balance) FILTER (WHERE "dueBucket" = 'no_due'), 0) AS "noDueDate",
            COUNT(*) FILTER (WHERE "dueBucket" = 'no_due') AS "noDueDateCount" FROM obligations
    ), selected AS (
        SELECT * FROM obligations WHERE :bucket = 'all' OR "dueBucket" = :bucket
    ), page_rows AS (
        SELECT o.id, o."patientID", o."documentNumber", o."documentYear", o."documentType", o."emissionDate",
            o."paymentTerms", o."invoiceTotal"::text AS "invoiceTotal", o."invoiceNet"::text AS "invoiceNet", o.status,
            CASE WHEN p.id IS NULL THEN 'Paziente non disponibile'
                ELSE CONCAT_WS(' ', NULLIF(p.name, ''), NULLIF(p.surname, '')) END AS "patientName",
            o."paidAmount", o.balance, o."paymentStatus", o."hasUndatedLegacyPayments",
            o."paymentTerms" AS "dueDate", o."dueBucket", o."daysOverdue"
        FROM selected o LEFT JOIN ${prefix}.patients p ON p.id = o."patientID"
        ORDER BY o."paymentTerms" ASC NULLS LAST, o.id ASC LIMIT :size OFFSET :offset
    ) SELECT JSON_BUILD_OBJECT('totals', (SELECT ROW_TO_JSON(t) FROM totals t),
        'pagination', JSON_BUILD_OBJECT('length', (SELECT COUNT(*) FROM selected), 'page', :page, 'size', :size,
            'lastPage', GREATEST(CEIL((SELECT COUNT(*) FROM selected)::numeric / :size), 1)),
        'invoices', COALESCE((SELECT JSON_AGG(p ORDER BY p."dueDate" ASC NULLS LAST, p.id ASC) FROM page_rows p), '[]'::json)) AS result`;
    const rows = await database.query<{result: ReceivablesPage}>(sql, {type: QueryTypes.SELECT,
        replacements: {structureIds: [...structureIds], operatorId: query.operatorId, eventTypeId: query.eventTypeId,
            eventTypeIds: query.eventTypeIds ? [...query.eventTypeIds] : [], patientId: query.patientId ?? null,
            today, bucket, page, size, offset: (page - 1) * size}});
    return rows[0].result;
}

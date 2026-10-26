import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import AgendaEvent from '../models/agendaEvent.model.js';
import {AUTOMATIC_APPOINTMENT_COMPLETION_INTERVAL_MS, AUTOMATIC_APPOINTMENT_COMPLETION_LOOKBACK_MS} from './appointmentCompletion.policy.js';
import {completeUntouchedAppointmentById} from './automaticAppointmentCompletion.service.js';
export {AUTOMATIC_APPOINTMENT_COMPLETION_INTERVAL_MS, AUTOMATIC_APPOINTMENT_COMPLETION_LOOKBACK_MS,
    appointmentEndAt, shouldAutoCompleteAppointment, shouldOpenAttendanceCorrection} from './appointmentCompletion.policy.js';

const TENANT_SCHEMA_PATTERN = /^rehablo_[a-z0-9]+$/i;
const preparedSchemas = new Set<string>();
const MISSED_ARRIVAL_COLUMNS = {
    carePackageId: 'UUID NULL',
    packageReservationStatus: 'VARCHAR(16) NULL',
    missedArrivalReportedAt: 'TIMESTAMPTZ NULL',
    missedArrivalReportedBy: 'UUID NULL',
    missedArrivalResolvedAt: 'TIMESTAMPTZ NULL',
    missedArrivalResolvedBy: 'UUID NULL',
    missedArrivalResolution: 'VARCHAR(24) NULL',
    noShowBillingDecision: 'VARCHAR(16) NULL'
} as const;

/**
 * Il job parte prima della prima richiesta autenticata, quindi non può dipendere
 * dalla sincronizzazione lazy del tenant. Allinea in modo additivo soltanto le
 * colonne del workflow che usa, una volta per schema e per processo.
 */
export async function ensureMissedArrivalWorkflowColumns(schema: string): Promise<void> {
    if (preparedSchemas.has(schema)) return;
    if (!TENANT_SCHEMA_PATTERN.test(schema)) {
        throw new Error(`Schema tenant non valido: ${schema}`);
    }

    const existingColumns = await sequelize.query<{ columnName: string }>(
        `SELECT column_name AS "columnName"
         FROM information_schema.columns
         WHERE table_schema = :schema
           AND table_name = 'agenda_events'`,
        { replacements: { schema }, type: QueryTypes.SELECT }
    );
    const existing = new Set(existingColumns.map(column => column.columnName));
    const missing = Object.entries(MISSED_ARRIVAL_COLUMNS)
        .filter(([column]) => !existing.has(column));

    if (missing.length > 0) {
        const additions = missing
            .map(([column, definition]) => `ADD COLUMN IF NOT EXISTS "${column}" ${definition}`)
            .join(',\n                ');
        await sequelize.query(
            `ALTER TABLE "${schema}"."agenda_events"
                ${additions}`
        );
        console.log(
            `[agenda] ${schema}: aggiunte colonne workflow mancato arrivo -> ` +
            missing.map(([column]) => column).join(', ')
        );
    }

    preparedSchemas.add(schema);
}

export async function autoCompleteEndedAppointmentsForSchema(
    schema: string,
    now: Date = new Date()
): Promise<number> {
    await ensureMissedArrivalWorkflowColumns(schema);
    const TenantAgendaEvent = AgendaEvent.schema(schema);
    const earliestCandidateStart = new Date(
        now.getTime() - AUTOMATIC_APPOINTMENT_COMPLETION_LOOKBACK_MS * 2
    ).toISOString();

    const singleAppointmentWhere = {
        [Op.and]: [
            { [Op.or]: [{ recurrence: null }, { recurrence: '' }] },
            { [Op.or]: [{ recurringEventId: null }, { recurringEventId: '' }] }
        ]
    };

    // IDs are only a work list. Every candidate is re-read under patient/event locks before any write.
    const candidates = await TenantAgendaEvent.findAll({attributes: ['id'], where: {
        status: { [Op.iLike]: 'CONFIRMED' }, invoiceId: null, missedArrivalReportedAt: null,
        start: { [Op.gte]: earliestCandidateStart, [Op.lte]: now.toISOString() }, ...singleAppointmentWhere
    }});

    let completed = 0;
    for (const candidate of candidates) {
        try {
            if (await completeUntouchedAppointmentById(schema, candidate.id, {now})) completed++;
        } catch (error) {
            // A package that needs verification stays unchanged and cannot stop the remaining appointments.
            console.error('[agenda] completamento automatico fallito per ' + schema + '/' + candidate.id, error);
        }
    }
    return completed;
}

export async function autoCompleteEndedAppointmentsForAllTenants(
    now: Date = new Date()
): Promise<number> {
    const schemas = await sequelize.query<{ schemaName: string }>(
        `SELECT table_schema AS "schemaName"
         FROM information_schema.tables
         WHERE table_name = 'agenda_events'
           AND table_schema LIKE 'rehablo\\_%' ESCAPE '\\'`,
        { type: QueryTypes.SELECT }
    );

    let completed = 0;
    for (const { schemaName } of schemas) {
        try {
            completed += await autoCompleteEndedAppointmentsForSchema(schemaName, now);
        } catch (error) {
            console.error(`[agenda] completamento automatico fallito per ${schemaName}`, error);
        }
    }
    return completed;
}

export function startAutomaticAppointmentCompletionSweep(
    intervalMs = AUTOMATIC_APPOINTMENT_COMPLETION_INTERVAL_MS
): NodeJS.Timeout {
    let running = false;
    const run = async () => {
        if (running) return;
        running = true;
        try {
            const completed = await autoCompleteEndedAppointmentsForAllTenants();
            if (completed > 0) {
                console.log(`[agenda] ${completed} appuntamenti completati automaticamente`);
            }
        } catch (error) {
            console.error('[agenda] completamento automatico degli appuntamenti fallito', error);
        } finally {
            running = false;
        }
    };

    void run();
    const timer = setInterval(() => void run(), intervalMs);
    timer.unref();
    return timer;
}

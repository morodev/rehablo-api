import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import AgendaEvent, { AgendaEventAttributes } from '../models/agendaEvent.model.js';

export const AUTOMATIC_MISSED_ARRIVAL_INTERVAL_MS = 30_000;
export const AUTOMATIC_MISSED_ARRIVAL_LOOKBACK_MS = 24 * 60 * 60_000;

const TENANT_SCHEMA_PATTERN = /^rehablo_[a-z0-9]+$/i;
const preparedSchemas = new Set<string>();
const MISSED_ARRIVAL_COLUMNS = {
    missedArrivalReportedAt: 'TIMESTAMPTZ NULL',
    missedArrivalReportedBy: 'UUID NULL',
    missedArrivalResolvedAt: 'TIMESTAMPTZ NULL',
    missedArrivalResolvedBy: 'UUID NULL',
    missedArrivalResolution: 'VARCHAR(24) NULL',
    noShowBillingDecision: 'VARCHAR(16) NULL'
} as const;

type AppointmentLike = Pick<
    AgendaEventAttributes,
    | 'start'
    | 'end'
    | 'duration'
    | 'status'
    | 'recurrence'
    | 'recurringEventId'
    | 'invoiceId'
    | 'patientId'
    | 'patient'
    | 'missedArrivalReportedAt'
>;

export function appointmentEndAt(event: AppointmentLike): Date | null {
    const startAt = Date.parse(String(event.start ?? ''));
    if (!Number.isFinite(startAt)) return null;

    const explicitEndAt = Date.parse(String(event.end ?? ''));
    if (Number.isFinite(explicitEndAt) && explicitEndAt > startAt) {
        return new Date(explicitEndAt);
    }

    const durationMinutes = Number(event.duration);
    return Number.isFinite(durationMinutes) && durationMinutes > 0
        ? new Date(startAt + durationMinutes * 60_000)
        : null;
}

/**
 * Decide se aprire la segnalazione operativa senza attribuire automaticamente
 * l'esito COMPLETED o NO_SHOW all'appuntamento.
 */
export function shouldAutoReportMissedArrival(
    event: AppointmentLike,
    now: Date = new Date()
): boolean {
    if (String(event.status ?? '').toUpperCase() !== 'CONFIRMED') return false;
    if (event.invoiceId || event.recurrence || event.recurringEventId || event.missedArrivalReportedAt) return false;

    const patient = event.patient as Record<string, unknown> | null | undefined;
    if (!event.patientId && !patient?.id) return false;

    const end = appointmentEndAt(event);
    if (!end) return false;

    const elapsed = now.getTime() - end.getTime();
    return elapsed >= 0 && elapsed <= AUTOMATIC_MISSED_ARRIVAL_LOOKBACK_MS;
}

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

export async function autoReportEndedMissedArrivalsForSchema(
    schema: string,
    now: Date = new Date()
): Promise<number> {
    await ensureMissedArrivalWorkflowColumns(schema);
    const TenantAgendaEvent = AgendaEvent.schema(schema);
    const earliestCandidateStart = new Date(
        now.getTime() - AUTOMATIC_MISSED_ARRIVAL_LOOKBACK_MS * 2
    ).toISOString();

    const singleAppointmentWhere = {
        [Op.and]: [
            { [Op.or]: [{ recurrence: null }, { recurrence: '' }] },
            { [Op.or]: [{ recurringEventId: null }, { recurringEventId: '' }] }
        ]
    };

    const candidates = await TenantAgendaEvent.findAll({
        // Alcuni tenant legacy non hanno ancora tutte le colonne più recenti del
        // modello (per esempio patientId). Lo sweep usa solo i campi necessari e
        // ricava il paziente anche dallo snapshot JSON storico.
        attributes: [
            'id',
            'start',
            'end',
            'duration',
            'status',
            'recurrence',
            'recurringEventId',
            'invoiceId',
            'patient',
            'missedArrivalReportedAt'
        ],
        where: {
            status: { [Op.iLike]: 'CONFIRMED' },
            invoiceId: null,
            missedArrivalReportedAt: null,
            start: { [Op.gte]: earliestCandidateStart, [Op.lte]: now.toISOString() },
            ...singleAppointmentWhere
        }
    });

    let reported = 0;
    for (const candidate of candidates) {
        const event = candidate.get({ plain: true }) as AgendaEventAttributes;
        if (!shouldAutoReportMissedArrival(event, now)) continue;

        const end = appointmentEndAt(event)!;
        const [updated] = await TenantAgendaEvent.update(
            {
                missedArrivalReportedAt: end,
                missedArrivalReportedBy: null,
                missedArrivalResolvedAt: null,
                missedArrivalResolvedBy: null,
                missedArrivalResolution: null,
                noShowBillingDecision: null
            },
            {
                // Il filtro rende il job idempotente e impedisce di sovrascrivere
                // un esito registrato mentre lo sweep era in corso.
                where: {
                    id: candidate.id,
                    status: { [Op.iLike]: 'CONFIRMED' },
                    invoiceId: null,
                    missedArrivalReportedAt: null,
                    ...singleAppointmentWhere
                }
            }
        );
        reported += updated;
    }

    return reported;
}

export async function autoReportEndedMissedArrivalsForAllTenants(
    now: Date = new Date()
): Promise<number> {
    const schemas = await sequelize.query<{ schemaName: string }>(
        `SELECT table_schema AS "schemaName"
         FROM information_schema.tables
         WHERE table_name = 'agenda_events'
           AND table_schema LIKE 'rehablo\\_%' ESCAPE '\\'`,
        { type: QueryTypes.SELECT }
    );

    let reported = 0;
    for (const { schemaName } of schemas) {
        try {
            reported += await autoReportEndedMissedArrivalsForSchema(schemaName, now);
        } catch (error) {
            console.error(`[agenda] sweep mancati arrivi fallito per ${schemaName}`, error);
        }
    }
    return reported;
}

export function startAutomaticMissedArrivalSweep(
    intervalMs = AUTOMATIC_MISSED_ARRIVAL_INTERVAL_MS
): NodeJS.Timeout {
    let running = false;
    const run = async () => {
        if (running) return;
        running = true;
        try {
            const reported = await autoReportEndedMissedArrivalsForAllTenants();
            if (reported > 0) {
                console.log(`[agenda] ${reported} mancati arrivi segnalati automaticamente`);
            }
        } catch (error) {
            console.error('[agenda] sweep automatico dei mancati arrivi fallito', error);
        } finally {
            running = false;
        }
    };

    void run();
    const timer = setInterval(() => void run(), intervalMs);
    timer.unref();
    return timer;
}

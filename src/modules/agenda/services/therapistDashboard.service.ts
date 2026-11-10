import {Op, fn, col} from 'sequelize';
import AgendaEvent from '../models/agendaEvent.model.js';
import Patient from '../../patients/models/patient.model.js';
import {agendaDateBoundary} from './agendaSearch.service.js';

export function therapistDashboardBounds(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const start = agendaDateBoundary(date, false), end = agendaDateBoundary(date, true);
    if (!start || !end) return null;
    const civilHistory = new Date(date + 'T12:00:00.000Z');
    civilHistory.setUTCDate(civilHistory.getUTCDate() - 180);
    const historyStart = agendaDateBoundary(civilHistory.toISOString().slice(0, 10), false)!;
    return {start: start.toISOString(), end: end.toISOString(), historyStart: historyStart.toISOString()};
}

/** Same last-session semantics as the existing dashboard, including legacy snapshots and all statuses. */
export function lastTherapistSessions(rows: Array<Record<string, any>>, patientIds: Set<string>, currentPatientIds: Set<string>, dayStart: string): Record<string, string> {
    const latest = new Map<string, number>();
    const cutoff = Date.parse(dayStart);
    for (const event of rows) {
        const patientId = currentPatientIds.has(event.patientId) ? event.patientId : event.snapshotPatientId;
        const start = Date.parse(event.start);
        if (!patientIds.has(patientId) || ['Ferie', 'Permesso'].includes(event.title) || !Number.isFinite(start) || start >= cutoff) continue;
        if (!latest.has(patientId) || start > latest.get(patientId)!) latest.set(patientId, start);
    }
    return Object.fromEntries([...latest].map(([id, start]) => [id, new Date(start).toISOString()]));
}

export async function loadLastTherapistSessions(schema: string, events: Array<Record<string, any>>, scope: Record<string | symbol, any>, bounds: NonNullable<ReturnType<typeof therapistDashboardBounds>>) {
    const patientIds = new Set<string>(events.map(event => event.patient?.id).filter(id => typeof id === 'string' && id.length));
    if (!patientIds.size) return {};
    const ids = [...patientIds];
    const uuidIds = ids.filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
    const rows = await AgendaEvent.schema(schema).findAll({
        attributes: ['id', 'start', 'title', 'patientId', [fn('json_extract_path_text', col('patient'), 'id'), 'snapshotPatientId']],
        where: {[Op.and]: [scope,
            {[Op.or]: [{patientId: {[Op.in]: uuidIds}}, ...ids.map(id => ({patient: {id}}))]},
            {start: {[Op.lt]: bounds.start}},
            {[Op.or]: [{start: {[Op.gte]: bounds.historyStart}},
                {recurrence: {[Op.not]: null}, end: {[Op.gte]: bounds.historyStart}}]}
        ]}
    });
    const history = rows.map(row => row.get({plain: true}) as Record<string, any>);
    const historicalPatientIds = [...new Set(history.map(event => event.patientId).filter(Boolean))];
    const patients = historicalPatientIds.length ? await Patient.schema(schema).findAll({
        attributes: ['id'], where: {id: {[Op.in]: historicalPatientIds}}
    }) : [];
    return lastTherapistSessions(history, patientIds, new Set(patients.map(patient => String(patient.get('id')))), bounds.start);
}

import {
    ACTIVITY_ALERT_CHANNELS, ACTIVITY_PRIORITIES, ACTIVITY_STATUSES, ACTIVITY_TIMEZONE,
    ActivityAlertInput, ActivityArchiveInput, ActivityReviewInput, ActivityChanges, ActivityCreateInput,
    ActivityDue, ActivityDueFilter, ActivityMoveInput, ActivityPatchInput, ActivityPlacement,
    ActivityPriority, ActivityQuery, ActivityRecord, ActivityRestoreInput, ActivitySchedule,
    ActivityStatus, ActivityView, ActivityChecklistCreateInput, ActivityChecklistPatchInput,
    ActivityChecklistDeleteInput, ActivityChecklistMoveInput, ActivityChecklistPlacement,
    ActivityCommentCreateInput, ActivityCommentPatchInput, ActivityCommentDeleteInput, ActivityChildPageQuery
} from '../activities.types.js';
import {activityValidationError} from './activityErrors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const own = (value: object, field: string) => Object.prototype.hasOwnProperty.call(value, field);

function object(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        activityValidationError(field, 'Inserisci dati validi per questa operazione.');
    }
    return value as Record<string, unknown>;
}

function whitelist(value: Record<string, unknown>, allowed: readonly string[], prefix = ''): void {
    const extra = Object.keys(value).find(key => !allowed.includes(key));
    if (extra) activityValidationError(prefix ? prefix + '.' + extra : extra, 'Questo campo non può essere modificato con questa operazione.');
}

function text(value: unknown, field: string, max: number, required = true): string | null {
    if (!required && value === null) return null;
    if (typeof value !== 'string') activityValidationError(field, 'Inserisci un testo valido.');
    const normalized = value.trim();
    if (!normalized) {
        if (!required) return null;
        activityValidationError(field, field.endsWith('title') ? "Inserisci un titolo per l'attività." : 'Inserisci un testo.');
    }
    if (normalized.length > max) activityValidationError(field, 'Il testo non può superare ' + max + ' caratteri.');
    return normalized;
}

export function parseActivityId(value: unknown, field = 'id'): string {
    if (typeof value !== 'string' || !UUID.test(value)) activityValidationError(field, 'Inserisci un identificativo valido.');
    return value.toLowerCase();
}

function nullableId(value: unknown, field: string): string | null {
    return value === null ? null : parseActivityId(value, field);
}

function checklistPlacement(value: unknown): ActivityChecklistPlacement {
    const placement = object(value, 'placement');
    whitelist(placement, ['kind', 'itemId'], 'placement');
    const kind = choice(placement.kind, ['start', 'end', 'before'] as const, 'placement.kind');
    if (kind === 'before') return {kind, itemId: parseActivityId(placement.itemId, 'placement.itemId')};
    if (own(placement, 'itemId')) activityValidationError('placement.itemId', 'La posizione scelta non richiede un elemento di riferimento.');
    return {kind};
}

export function parseChecklistCreateInput(value: unknown): ActivityChecklistCreateInput {
    const input = object(value, 'body'); whitelist(input, ['operationId', 'expectedChecklistRevision', 'text', 'placement']);
    return {operationId: parseActivityId(input.operationId, 'operationId'),
        expectedChecklistRevision: integer(input.expectedChecklistRevision, 'expectedChecklistRevision'),
        text: text(input.text, 'text', 300)!, placement: own(input, 'placement') ? checklistPlacement(input.placement) : {kind: 'end'}};
}
export function parseChecklistPatchInput(value: unknown): ActivityChecklistPatchInput {
    const input = object(value, 'body'); whitelist(input, ['operationId', 'expectedVersion', 'changes', 'allowReopen', 'expectedActivityVersion']);
    const changes = object(input.changes, 'changes'); whitelist(changes, ['text', 'checked'], 'changes');
    if (!Object.keys(changes).length) activityValidationError('changes', 'Indica il testo oppure lo stato da aggiornare.');
    return {operationId: parseActivityId(input.operationId, 'operationId'), expectedVersion: integer(input.expectedVersion, 'expectedVersion', 1),
        ...(own(input, 'allowReopen') ? {allowReopen: boolean(input.allowReopen, 'allowReopen')} : {}),
        ...(own(input, 'expectedActivityVersion') ? {expectedActivityVersion: integer(input.expectedActivityVersion, 'expectedActivityVersion', 1)} : {}),
        changes: {...(own(changes, 'text') ? {text: text(changes.text, 'changes.text', 300)!} : {}),
            ...(own(changes, 'checked') ? {checked: boolean(changes.checked, 'changes.checked')} : {})}};
}
export function parseChecklistDeleteInput(value: unknown): ActivityChecklistDeleteInput {
    const input = object(value, 'body'); whitelist(input, ['operationId', 'expectedVersion', 'expectedChecklistRevision']);
    return {operationId: parseActivityId(input.operationId, 'operationId'), expectedVersion: integer(input.expectedVersion, 'expectedVersion', 1),
        expectedChecklistRevision: integer(input.expectedChecklistRevision, 'expectedChecklistRevision')};
}
export function parseChecklistMoveInput(value: unknown): ActivityChecklistMoveInput {
    const input = object(value, 'body'); whitelist(input, ['operationId', 'expectedChecklistRevision', 'placement']);
    return {operationId: parseActivityId(input.operationId, 'operationId'),
        expectedChecklistRevision: integer(input.expectedChecklistRevision, 'expectedChecklistRevision'), placement: checklistPlacement(input.placement)};
}
export function parseCommentCreateInput(value: unknown): ActivityCommentCreateInput {
    const input = object(value, 'body'); whitelist(input, ['operationId', 'text']);
    return {operationId: parseActivityId(input.operationId, 'operationId'), text: text(input.text, 'text', 5000)!};
}
export function parseCommentPatchInput(value: unknown): ActivityCommentPatchInput {
    const input = object(value, 'body'); whitelist(input, ['operationId', 'expectedVersion', 'text']);
    return {operationId: parseActivityId(input.operationId, 'operationId'), expectedVersion: integer(input.expectedVersion, 'expectedVersion', 1),
        text: text(input.text, 'text', 5000)!};
}
export function parseCommentDeleteInput(value: unknown): ActivityCommentDeleteInput {
    const input = object(value, 'body'); whitelist(input, ['operationId', 'expectedVersion']);
    return {operationId: parseActivityId(input.operationId, 'operationId'), expectedVersion: integer(input.expectedVersion, 'expectedVersion', 1)};
}
export function parseActivityChildPageQuery(value: Record<string, unknown>): ActivityChildPageQuery {
    whitelist(value, ['limit', 'cursor', 'offset', 'pagination']);
    if (value.pagination !== undefined && value.pagination !== 'cursor') activityValidationError('pagination', 'Usa la paginazione con cursore.');
    const offsetValue = value.offset === undefined ? '0' : queryString(value.offset, 'offset');
    if (!/^\d+$/.test(offsetValue) || !Number.isSafeInteger(Number(offsetValue))) activityValidationError('offset', 'La pagina richiesta non è valida.');
    if (value.cursor !== undefined && Number(offsetValue)) activityValidationError('cursor', 'Usa il cursore per caricare la pagina successiva.');
    return {limit: value.limit === undefined ? 20 : queryLimit(value.limit, 'limit'),
        cursor: value.cursor === undefined ? null : cursor(value.cursor, 'cursor'), offset: Number(offsetValue)};
}

function integer(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
        activityValidationError(field, 'Inserisci un numero intero valido.');
    }
    return value;
}

function boolean(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') activityValidationError(field, 'Inserisci un valore valido.');
    return value;
}

function choice<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
    if (typeof value !== 'string' || !allowed.includes(value as T)) activityValidationError(field, 'Seleziona un valore valido.');
    return value as T;
}

function ids(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) activityValidationError(field, 'Seleziona gli operatori della sede.');
    return [...new Set(value.map((item, index) => parseActivityId(item, field + '.' + index)))];
}

/** Only explicit UTC instants are accepted. Date's rollover parsing must never normalize input. */
export function parseActivityUtcInstant(value: unknown, field = 'due.at'): string {
    const match = typeof value === 'string' ? UTC_INSTANT.exec(value) : null;
    if (!match) activityValidationError(field, "Inserisci una data e un'ora valide in formato UTC.");
    const parsed = new Date(value as string);
    const expected = [
        Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]),
        Number(match[5]), Number(match[6]), Number((match[7] ?? '').padEnd(3, '0'))
    ];
    const actual = [
        parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate(),
        parsed.getUTCHours(), parsed.getUTCMinutes(), parsed.getUTCSeconds(), parsed.getUTCMilliseconds()
    ];
    if (expected[0] < 1 || !Number.isFinite(parsed.getTime()) || expected.some((part, i) => part !== actual[i])) {
        activityValidationError(field, "Inserisci una data e un'ora esistenti.");
    }
    return parsed.toISOString();
}

export function parseActivityCivilDate(value: unknown, field = 'due.date'): string {
    if (typeof value !== 'string' || !DATE_ONLY.test(value) || value.startsWith('0000-')) {
        activityValidationError(field, 'Inserisci una data valida nel formato anno-mese-giorno.');
    }
    const parsed = new Date(value + 'T00:00:00.000Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        activityValidationError(field, 'La data selezionata non esiste.');
    }
    return value;
}

export function parseActivityDue(value: unknown, timezone = ACTIVITY_TIMEZONE): ActivityDue {
    if (value === null) return null;
    const due = object(value, 'due');
    if (due.kind === 'timed') {
        whitelist(due, ['kind', 'at'], 'due');
        return {kind: 'timed', at: parseActivityUtcInstant(due.at)};
    }
    if (due.kind === 'allDay') {
        whitelist(due, ['kind', 'date', 'timezone'], 'due');
        if (due.timezone !== timezone || timezone !== ACTIVITY_TIMEZONE) {
            activityValidationError('due.timezone', 'La zona oraria deve coincidere con quella della bacheca.');
        }
        return {kind: 'allDay', date: parseActivityCivilDate(due.date), timezone};
    }
    activityValidationError('due.kind', 'Scegli una scadenza con ora oppure una giornata intera.');
}

export function parseActivityAlert(value: unknown): ActivityAlertInput | null {
    if (value === null) return null;
    const alert = object(value, 'alert');
    whitelist(alert, ['scheduledAt', 'channels'], 'alert');
    let channels = [...ACTIVITY_ALERT_CHANNELS].slice(0, 1);
    if (own(alert, 'channels')) {
        if (!Array.isArray(alert.channels)) activityValidationError('alert.channels', "Seleziona i canali dell'avviso.", 'INVALID_ALERT');
        channels = [...new Set(['inApp', ...alert.channels.map(channel =>
            choice(channel, ACTIVITY_ALERT_CHANNELS, 'alert.channels')
        )])] as typeof channels;
        channels.sort((a, b) => ACTIVITY_ALERT_CHANNELS.indexOf(a) - ACTIVITY_ALERT_CHANNELS.indexOf(b));
    }
    return {scheduledAt: parseActivityUtcInstant(alert.scheduledAt, 'alert.scheduledAt'), channels};
}

const CORE_FIELDS = ['title', 'description', 'priority', 'assigneeIds', 'due', 'alert', 'patientId', 'agendaEventId', 'reviewerUserId'] as const;

function coreChanges(value: Record<string, unknown>, timezone: string): ActivityChanges {
    const changes: ActivityChanges = {};
    if (own(value, 'title')) changes.title = text(value.title, 'title', 200)!;
    if (own(value, 'description')) changes.description = text(value.description, 'description', 5000, false);
    if (own(value, 'priority')) changes.priority = choice(value.priority, ACTIVITY_PRIORITIES, 'priority');
    if (own(value, 'reviewerUserId')) changes.reviewerUserId = nullableId(value.reviewerUserId, 'reviewerUserId');
    if (own(value, 'assigneeIds')) changes.assigneeIds = ids(value.assigneeIds, 'assigneeIds');
    if (own(value, 'due')) changes.due = parseActivityDue(value.due, timezone);
    if (own(value, 'alert')) changes.alert = parseActivityAlert(value.alert);
    if (own(value, 'patientId')) changes.patientId = nullableId(value.patientId, 'patientId');
    if (own(value, 'agendaEventId')) changes.agendaEventId = nullableId(value.agendaEventId, 'agendaEventId');
    return changes;
}

export function parseCreateActivityInput(value: unknown, options: {timezone?: string; defaultAssigneeIds?: string[]} = {}): ActivityCreateInput {
    const input = object(value, 'body');
    whitelist(input, [...CORE_FIELDS, 'operationId', 'status', 'checklist']);
    const changes = coreChanges(input, options.timezone ?? ACTIVITY_TIMEZONE);
    const checklist: Array<{text: string}> = [];
    if (own(input, 'checklist')) {
        if (!Array.isArray(input.checklist)) activityValidationError('checklist', 'Inserisci una checklist valida.');
        input.checklist.forEach((value, index) => {
            const item = object(value, 'checklist.' + index);
            whitelist(item, ['text'], 'checklist.' + index);
            checklist.push({text: text(item.text, 'checklist.' + index + '.text', 300)!});
        });
    }
    return {
        operationId: parseActivityId(input.operationId, 'operationId'),
        title: changes.title ?? text(undefined, 'title', 200)!,
        description: changes.description ?? null,
        status: own(input, 'status') ? choice(input.status, ACTIVITY_STATUSES, 'status') : 'TODO',
        priority: changes.priority ?? 'NORMAL',
        assigneeIds: changes.assigneeIds ?? options.defaultAssigneeIds ?? [],
        reviewerUserId: changes.reviewerUserId ?? null,
        due: changes.due ?? null,
        alert: changes.alert ?? null,
        patientId: changes.patientId ?? null,
        agendaEventId: changes.agendaEventId ?? null,
        checklist
    };
}

export function parsePatchActivityInput(value: unknown, timezone = ACTIVITY_TIMEZONE): ActivityPatchInput {
    const input = object(value, 'body');
    whitelist(input, ['operationId', 'expectedVersion', 'changes']);
    const changes = object(input.changes, 'changes');
    whitelist(changes, CORE_FIELDS, 'changes');
    if (!Object.keys(changes).length) activityValidationError('changes', 'Indica almeno un campo da modificare.');
    return {
        operationId: parseActivityId(input.operationId, 'operationId'),
        expectedVersion: integer(input.expectedVersion, 'expectedVersion', 1),
        changes: coreChanges(changes, timezone)
    };
}

function versionedCommand(value: unknown, extra: readonly string[] = []): {input: Record<string, unknown>; base: ActivityArchiveInput} {
    const input = object(value, 'body');
    whitelist(input, ['operationId', 'expectedVersion', 'expectedOrderRevision', ...extra]);
    return {input, base: {
        operationId: parseActivityId(input.operationId, 'operationId'),
        expectedVersion: integer(input.expectedVersion, 'expectedVersion', 1),
        expectedOrderRevision: integer(input.expectedOrderRevision, 'expectedOrderRevision')
    }};
}

export function parseActivityReviewInput(value: unknown): ActivityReviewInput {
    const {input, base} = versionedCommand(value, ['action', 'expectedChecklistRevision', 'comment']);
    const action = choice(input.action, ['request', 'approveAndComplete', 'authorizeCompletion', 'returnToProgress'] as const, 'action');
    return {...base, action, expectedChecklistRevision: integer(input.expectedChecklistRevision, 'expectedChecklistRevision'),
        ...(action === 'returnToProgress' ? {comment: text(input.comment, 'comment', 5000)!} : {})};
}

export function parseMoveActivityInput(value: unknown): ActivityMoveInput {
    const {input, base} = versionedCommand(value, ['targetStatus', 'placement', 'expectedChecklistRevision', 'allowIncompleteChecklist']);
    const requested = object(input.placement, 'placement');
    let placement: ActivityPlacement;
    if (requested.kind === 'before') {
        whitelist(requested, ['kind', 'activityId'], 'placement');
        placement = {kind: 'before', activityId: parseActivityId(requested.activityId, 'placement.activityId')};
    } else {
        whitelist(requested, ['kind'], 'placement');
        placement = {kind: choice(requested.kind, ['start', 'end'] as const, 'placement.kind')};
    }
    return {
        ...base, placement,
        targetStatus: choice(input.targetStatus, ACTIVITY_STATUSES, 'targetStatus'),
        ...(own(input, 'expectedChecklistRevision') ? {expectedChecklistRevision: integer(input.expectedChecklistRevision, 'expectedChecklistRevision')} : {}),
        ...(own(input, 'allowIncompleteChecklist') ? {allowIncompleteChecklist: boolean(input.allowIncompleteChecklist, 'allowIncompleteChecklist')} : {})
    };
}

export function parseArchiveActivityInput(value: unknown): ActivityArchiveInput {
    return versionedCommand(value).base;
}
export function parseRestoreActivityInput(value: unknown): ActivityRestoreInput {
    return versionedCommand(value).base;
}

function queryString(value: unknown, field: string): string {
    if (typeof value !== 'string') activityValidationError(field, 'Il filtro selezionato non è valido.');
    return value;
}
function queryBoolean(value: unknown, field: string): boolean {
    if (value === undefined) return false;
    const normalized = queryString(value, field);
    if (normalized !== 'true' && normalized !== 'false') activityValidationError(field, 'Il filtro selezionato non è valido.');
    return normalized === 'true';
}
function queryLimit(value: unknown, field: string): number {
    const raw = queryString(value, field);
    if (!/^[1-9]\d{0,2}$/.test(raw)) activityValidationError(field, 'Scegli un numero di attività tra 1 e 200.');
    return integer(Number(raw), field, 1, 200);
}
function cursor(value: unknown, field: string): string {
    const result = queryString(value, field);
    if (!result || result.length > 8192) activityValidationError(field, 'Il cursore della pagina non è valido.');
    return result;
}
function queryMap<T>(value: unknown, field: string, parse: (value: unknown, field: string) => T): Partial<Record<ActivityStatus, T>> {
    if (value === undefined) return {};
    let decoded: unknown;
    try { decoded = JSON.parse(queryString(value, field)); }
    catch { activityValidationError(field, 'La configurazione delle colonne non è valida.'); }
    const values = object(decoded, field);
    whitelist(values, ACTIVITY_STATUSES, field);
    const result: Partial<Record<ActivityStatus, T>> = {};
    for (const [status, value] of Object.entries(values)) result[status as ActivityStatus] = parse(value, field + '.' + status);
    return result;
}

export function parseActivityQuery(value: unknown): ActivityQuery {
    const input = object(value, 'query');
    whitelist(input, ['view', 'search', 'mine', 'statuses', 'priority', 'assigneeId', 'due', 'unassigned',
        'reassignmentRequired', 'patientId', 'agendaEventId', 'includeAllCompleted', 'limit', 'cursor', 'limits', 'cursors']);
    const requestedStatuses = input.statuses === undefined ? []
        : queryString(input.statuses, 'statuses').split(',').map(value => choice(value, ACTIVITY_STATUSES, 'statuses'));
    return {
        view: input.view === undefined ? 'board' : choice(queryString(input.view, 'view'), ['board', 'list', 'archived'] as readonly ActivityView[], 'view'),
        search: input.search === undefined ? '' : text(queryString(input.search, 'search'), 'search', 200, false) ?? '',
        mine: queryBoolean(input.mine, 'mine'),
        statuses: ACTIVITY_STATUSES.filter(status => requestedStatuses.includes(status)),
        priority: input.priority === undefined ? null : choice(queryString(input.priority, 'priority'), ACTIVITY_PRIORITIES, 'priority') as ActivityPriority,
        assigneeId: input.assigneeId === undefined ? null : parseActivityId(queryString(input.assigneeId, 'assigneeId'), 'assigneeId'),
        due: input.due === undefined ? null : choice(queryString(input.due, 'due'), ['today', 'overdue', 'todayOrOverdue', 'upcoming', 'none'] as readonly ActivityDueFilter[], 'due'),
        unassigned: queryBoolean(input.unassigned, 'unassigned'),
        reassignmentRequired: queryBoolean(input.reassignmentRequired, 'reassignmentRequired'),
        patientId: input.patientId === undefined ? null : parseActivityId(queryString(input.patientId, 'patientId'), 'patientId'),
        agendaEventId: input.agendaEventId === undefined ? null : parseActivityId(queryString(input.agendaEventId, 'agendaEventId'), 'agendaEventId'),
        includeAllCompleted: queryBoolean(input.includeAllCompleted, 'includeAllCompleted'),
        limit: input.limit === undefined ? 20 : queryLimit(input.limit, 'limit'),
        cursor: input.cursor === undefined ? null : cursor(input.cursor, 'cursor'),
        limits: queryMap(input.limits, 'limits', (value, field) => integer(value, field, 1, 200)),
        cursors: queryMap(input.cursors, 'cursors', cursor)
    };
}

export function parseActivitySummaryQuery(value: unknown): {mine: boolean; limit: number} {
    const input = object(value, 'query');
    whitelist(input, ['mine', 'limit']);
    const limit = input.limit === undefined ? 5 : queryLimit(input.limit, 'limit');
    if (limit > 5) activityValidationError('limit', 'Puoi visualizzare al massimo cinque attività per gruppo.');
    return {mine: queryBoolean(input.mine, 'mine'), limit};
}

export function parseActivityLinksQuery(value: unknown): {patientId: string | null; agendaEventId: string | null} {
    const input = object(value, 'query');
    whitelist(input, ['patientId', 'agendaEventId']);
    const patientId = input.patientId === undefined ? null : parseActivityId(queryString(input.patientId, 'patientId'), 'patientId');
    const agendaEventId = input.agendaEventId === undefined ? null : parseActivityId(queryString(input.agendaEventId, 'agendaEventId'), 'agendaEventId');
    if (!patientId && !agendaEventId) activityValidationError('patientId', 'Seleziona un paziente o un appuntamento da collegare.');
    return {patientId, agendaEventId};
}

const romeFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: ACTIVITY_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

function civilParts(instant: Date): Record<string, number> {
    return Object.fromEntries(romeFormatter.formatToParts(instant).filter(part => part.type !== 'literal')
        .map(part => [part.type, Number(part.value)]));
}

export function activityLocalDate(instant: Date): string {
    const parts = civilParts(instant);
    return String(parts.year).padStart(4, '0') + '-' + String(parts.month).padStart(2, '0') + '-' + String(parts.day).padStart(2, '0');
}

/** Rome midnight uses the offset of that date, not today's offset or a fixed 24-hour day. */
function localMidnight(civilEpoch: number): number {
    let candidate = civilEpoch;
    for (let attempt = 0; attempt < 4; attempt++) {
        const parts = civilParts(new Date(candidate));
        const wallDate = new Date(0);
        wallDate.setUTCFullYear(parts.year, parts.month - 1, parts.day);
        wallDate.setUTCHours(parts.hour, parts.minute, parts.second, 0);
        const wallClock = wallDate.getTime();
        const correction = civilEpoch - wallClock;
        if (!correction) return candidate;
        candidate += correction;
    }
    activityValidationError('due.date', 'La data non può essere risolta nella zona oraria della bacheca.');
}

export function effectiveDueAt(due: ActivityDue): Date | null {
    if (!due) return null;
    if (due.kind === 'timed') return new Date(parseActivityUtcInstant(due.at));
    const normalized = parseActivityDue(due);
    if (!normalized || normalized.kind !== 'allDay') return null;
    const nextDay = new Date(normalized.date + 'T00:00:00.000Z');
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    return new Date(localMidnight(nextDay.getTime()) - 1);
}

export function dueFromActivity(activity: Pick<ActivityRecord, 'dueKind' | 'dueAt' | 'dueDate' | 'dueTimezone'>): ActivityDue {
    if (activity.dueKind === 'timed') {
        if (!activity.dueAt) throw new Error('Invalid persisted activity timed due');
        return {kind: 'timed', at: new Date(activity.dueAt).toISOString()};
    }
    if (activity.dueKind === 'allDay') {
        if (!activity.dueDate || !activity.dueTimezone) throw new Error('Invalid persisted activity all-day due');
        return {kind: 'allDay', date: activity.dueDate, timezone: activity.dueTimezone};
    }
    return null;
}

function dueKey(due: ActivityDue): string {
    return JSON.stringify(due ? parseActivityDue(due) : null);
}
function alertKey(alert: ActivityAlertInput | null): string {
    return JSON.stringify(alert ? parseActivityAlert(alert) : null);
}

export function validateActivitySchedule(
    schedule: ActivitySchedule, original: ActivitySchedule | null = null,
    now = new Date(), timezone = ACTIVITY_TIMEZONE
): void {
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid activity server time');
    const due = parseActivityDue(schedule.due, timezone);
    const alert = parseActivityAlert(schedule.alert);
    const deadline = effectiveDueAt(due);
    const dueChanged = !original || dueKey(due) !== dueKey(original.due);
    const pastDue = due?.kind === 'allDay' ? due.date < activityLocalDate(now)
        : !!deadline && deadline.getTime() <= now.getTime();
    if (due && dueChanged && pastDue) {
        activityValidationError(due.kind === 'timed' ? 'due.at' : 'due.date',
            due.kind === 'timed' ? "La data e l'ora selezionate sono già passate. Scegli una scadenza futura."
                : 'Scegli oggi o un giorno futuro per la scadenza.');
    }
    if (!alert) return;
    if (schedule.status === 'COMPLETED' || schedule.archivedAt) {
        activityValidationError('alert', "Riapri o ripristina l'attività prima di attivare un avviso.", 'INVALID_ALERT');
    }
    if (!schedule.assigneeIds.length) {
        activityValidationError('assigneeIds', "Assegna l'attività ad almeno un operatore prima di attivare l'avviso.", 'INVALID_ALERT');
    }
    const scheduledAt = new Date(alert.scheduledAt);
    const alertChanged = !original || alertKey(alert) !== alertKey(original.alert);
    // A historical alert is not silently reactivated and must not block unrelated edits.
    if (alertChanged && scheduledAt.getTime() <= now.getTime()) {
        activityValidationError('alert.scheduledAt', "L'avviso deve essere programmato nel futuro.", 'INVALID_ALERT');
    }
    if (deadline && scheduledAt.getTime() > deadline.getTime()) {
        activityValidationError('alert.scheduledAt', "L'avviso non può essere successivo alla scadenza dell'attività.", 'INVALID_ALERT');
    }
}

export function isActivityOverdue(due: ActivityDue, status: ActivityStatus, archivedAt: unknown, evaluationAt = new Date()): boolean {
    const deadline = effectiveDueAt(due);
    return !!deadline && !archivedAt && status !== 'COMPLETED' && deadline.getTime() < evaluationAt.getTime();
}

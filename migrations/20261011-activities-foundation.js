'use strict';

// Additive and independently runnable: TENANT_SCHEMA_SYNC=off does not run model sync.
const VERSION = '20261011-activities-foundation';
const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
const schemaPattern = /^rehablo_[a-f0-9]{32}$/i;
const timestampColumns = '"createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()';
const tables = {
    activity_boards: `
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "structureId" UUID NOT NULL,
        "timezone" VARCHAR(96) NOT NULL DEFAULT 'Europe/Rome',
        "orderRevision" INTEGER NOT NULL DEFAULT 0,
        "snapshotRevision" INTEGER NOT NULL DEFAULT 0,
        ${timestampColumns}`,
    activities: `
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "boardId" UUID NOT NULL,
        "title" VARCHAR(200) NOT NULL,
        "description" TEXT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'TODO',
        "priority" VARCHAR(8) NOT NULL DEFAULT 'NORMAL',
        "position" BIGINT NOT NULL DEFAULT 0,
        "version" INTEGER NOT NULL DEFAULT 1,
        "checklistRevision" INTEGER NOT NULL DEFAULT 0,
        "dueKind" VARCHAR(8) NULL,
        "dueAt" TIMESTAMPTZ NULL,
        "dueDate" DATE NULL,
        "dueTimezone" VARCHAR(96) NULL,
        "createdByUserId" UUID NOT NULL,
        "updatedByUserId" UUID NULL,
        "patientId" UUID NULL,
        "agendaEventId" UUID NULL,
        "completedAt" TIMESTAMPTZ NULL,
        "completedByUserId" UUID NULL,
        "archivedAt" TIMESTAMPTZ NULL,
        "archivedByUserId" UUID NULL,
        "reassignmentRequired" BOOLEAN NOT NULL DEFAULT false,
        ${timestampColumns}`,
    activity_assignments: `
        "activityId" UUID NOT NULL,
        "userId" UUID NOT NULL,
        "assignedByUserId" UUID NOT NULL,
        ${timestampColumns},
        PRIMARY KEY ("activityId", "userId")`,
    activity_checklist_items: `
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "activityId" UUID NOT NULL,
        "createdByUserId" UUID NOT NULL,
        "text" VARCHAR(300) NOT NULL,
        "position" BIGINT NOT NULL DEFAULT 0,
        "checked" BOOLEAN NOT NULL DEFAULT false,
        "checkedByUserId" UUID NULL,
        "checkedAt" TIMESTAMPTZ NULL,
        "version" INTEGER NOT NULL DEFAULT 1,
        ${timestampColumns}`,
    activity_comments: `
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "activityId" UUID NOT NULL,
        "authorUserId" UUID NOT NULL,
        "text" TEXT NULL,
        "version" INTEGER NOT NULL DEFAULT 1,
        "editedAt" TIMESTAMPTZ NULL,
        "deletedAt" TIMESTAMPTZ NULL,
        ${timestampColumns}`,
    activity_history: `
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "activityId" UUID NOT NULL,
        "actorUserId" UUID NULL,
        "eventType" VARCHAR(64) NOT NULL,
        "data" JSONB NOT NULL DEFAULT '{}'::jsonb,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    activity_alerts: `
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "activityId" UUID NOT NULL,
        "enabled" BOOLEAN NOT NULL DEFAULT false,
        "scheduledAt" TIMESTAMPTZ NULL,
        "scheduleVersion" INTEGER NOT NULL DEFAULT 1,
        "channels" VARCHAR(16)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(16)[],
        ${timestampColumns}`,
    // Delivery state is provisioned now. No worker, feed or scheduler is activated in phase 1.
    activity_deliveries: `
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "alertId" UUID NOT NULL,
        "recipientUserId" UUID NOT NULL,
        "scheduleVersion" INTEGER NOT NULL,
        "channel" VARCHAR(16) NOT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
        "scheduledAt" TIMESTAMPTZ NOT NULL,
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "nextAttemptAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "leaseUntil" TIMESTAMPTZ NULL,
        "leaseToken" UUID NULL,
        "lastError" VARCHAR(255) NULL,
        "providerReference" VARCHAR(255) NULL,
        "sentAt" TIMESTAMPTZ NULL,
        "readAt" TIMESTAMPTZ NULL,
        ${timestampColumns}`,
    activity_operations: `
        "boardId" UUID NOT NULL,
        "actorUserId" UUID NOT NULL,
        "operationId" UUID NOT NULL,
        "command" VARCHAR(128) NOT NULL,
        "inputHash" VARCHAR(64) NOT NULL,
        "responseStatus" INTEGER NOT NULL,
        "responseBody" JSONB NOT NULL,
        "expiresAt" TIMESTAMPTZ NOT NULL,
        ${timestampColumns},
        PRIMARY KEY ("boardId", "actorUserId", "operationId")`
};

// Names are schema-local and stable, so running after model sync or replaying is safe.
const checks = [
    ['activity_boards', 'activity_boards_revisions_check', '"orderRevision" >= 0 AND "snapshotRevision" >= 0'],
    ['activity_boards', 'activity_boards_timezone_check', 'length(btrim("timezone")) > 0'],
    ['activities', 'activities_title_check', 'length(btrim("title")) BETWEEN 1 AND 200'],
    ['activities', 'activities_description_check', '"description" IS NULL OR length("description") <= 5000'],
    ['activities', 'activities_status_check', `"status" IN ('TODO', 'IN_PROGRESS', 'WAITING', 'COMPLETED')`],
    ['activities', 'activities_priority_check', `"priority" IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')`],
    ['activities', 'activities_versions_check', '"version" >= 1 AND "checklistRevision" >= 0'],
    ['activities', 'activities_due_shape_check', `
        ("dueKind" IS NULL AND "dueAt" IS NULL AND "dueDate" IS NULL AND "dueTimezone" IS NULL)
        OR ("dueKind" = 'timed' AND "dueAt" IS NOT NULL AND "dueDate" IS NULL AND "dueTimezone" IS NULL)
        OR ("dueKind" = 'allDay' AND "dueAt" IS NULL AND "dueDate" IS NOT NULL
            AND "dueTimezone" IS NOT NULL AND length(btrim("dueTimezone")) > 0)`],
    ['activities', 'activities_completion_check', `
        ("status" = 'COMPLETED' AND "completedAt" IS NOT NULL AND "completedByUserId" IS NOT NULL)
        OR ("status" <> 'COMPLETED' AND "completedAt" IS NULL AND "completedByUserId" IS NULL)`],
    ['activities', 'activities_archive_check', `
        ("archivedAt" IS NULL AND "archivedByUserId" IS NULL)
        OR ("archivedAt" IS NOT NULL AND "archivedByUserId" IS NOT NULL)`],
    ['activity_checklist_items', 'activity_checklist_text_check', 'length(btrim("text")) BETWEEN 1 AND 300'],
    ['activity_checklist_items', 'activity_checklist_version_check', '"version" >= 1'],
    ['activity_checklist_items', 'activity_checklist_checked_check', `
        ("checked" = false AND "checkedAt" IS NULL AND "checkedByUserId" IS NULL)
        OR ("checked" = true AND "checkedAt" IS NOT NULL AND "checkedByUserId" IS NOT NULL)`],
    ['activity_comments', 'activity_comments_text_check', `
        ("deletedAt" IS NULL AND "text" IS NOT NULL AND length(btrim("text")) BETWEEN 1 AND 5000)
        OR ("deletedAt" IS NOT NULL AND "text" IS NULL)`],
    ['activity_comments', 'activity_comments_version_check', '"version" >= 1'],
    ['activity_history', 'activity_history_event_check', 'length(btrim("eventType")) > 0'],
    ['activity_history', 'activity_history_data_check', `jsonb_typeof("data") = 'object'`],
    ['activity_alerts', 'activity_alerts_version_check', '"scheduleVersion" >= 1'],
    ['activity_alerts', 'activity_alerts_channels_check', `
        "channels" <@ ARRAY['inApp', 'push', 'email']::VARCHAR(16)[]
        AND array_position("channels", NULL) IS NULL AND cardinality("channels") <= 3
        AND cardinality("channels") =
            (CASE WHEN 'inApp' = ANY("channels") THEN 1 ELSE 0 END
            + CASE WHEN 'push' = ANY("channels") THEN 1 ELSE 0 END
            + CASE WHEN 'email' = ANY("channels") THEN 1 ELSE 0 END)`],
    ['activity_alerts', 'activity_alerts_enabled_check', 'NOT "enabled" OR ("scheduledAt" IS NOT NULL AND cardinality("channels") > 0)'],
    ['activity_deliveries', 'activity_deliveries_channel_check', `"channel" IN ('inApp', 'push', 'email')`],
    ['activity_deliveries', 'activity_deliveries_status_check', `"status" IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED', 'UNCERTAIN')`],
    ['activity_deliveries', 'activity_deliveries_versions_check', '"scheduleVersion" >= 1 AND "attempts" >= 0'],
    ['activity_deliveries', 'activity_deliveries_lease_check', `
        ("leaseUntil" IS NULL AND "leaseToken" IS NULL)
        OR ("leaseUntil" IS NOT NULL AND "leaseToken" IS NOT NULL)`],
    ['activity_operations', 'activity_operations_command_check', 'length(btrim("command")) > 0'],
    ['activity_operations', 'activity_operations_hash_check', `"inputHash" ~ '^[a-f0-9]{64}$'`],
    ['activity_operations', 'activity_operations_response_check', `"responseStatus" BETWEEN 200 AND 299 AND jsonb_typeof("responseBody") = 'object'`]
];
const foreignKeys = [
    ['activities', 'activities_boardId_fkey', 'boardId', 'activity_boards', 'RESTRICT'],
    ['activity_assignments', 'activity_assignments_activityId_fkey', 'activityId', 'activities', 'CASCADE'],
    ['activity_checklist_items', 'activity_checklist_items_activityId_fkey', 'activityId', 'activities', 'CASCADE'],
    ['activity_comments', 'activity_comments_activityId_fkey', 'activityId', 'activities', 'CASCADE'],
    ['activity_history', 'activity_history_activityId_fkey', 'activityId', 'activities', 'CASCADE'],
    ['activity_alerts', 'activity_alerts_activityId_fkey', 'activityId', 'activities', 'CASCADE'],
    ['activity_deliveries', 'activity_deliveries_alertId_fkey', 'alertId', 'activity_alerts', 'CASCADE'],
    ['activity_operations', 'activity_operations_boardId_fkey', 'boardId', 'activity_boards', 'CASCADE']
];
const indexes = [
    ['activity_boards', 'activity_boards_structure_unique', true, '"structureId"'],
    // Negative temporary ranks are allowed for transaction-local, two-pass compaction.
    ['activities', 'activities_active_position_unique', true, '"boardId", "status", "position"', '"archivedAt" IS NULL'],
    ['activities', 'activities_board_archive_updated_idx', false, '"boardId", "archivedAt", "updatedAt", "id"'],
    ['activities', 'activities_board_completed_idx', false, '"boardId", "completedAt", "id"', '"archivedAt" IS NULL AND "status" = \'COMPLETED\''],
    ['activities', 'activities_board_due_at_idx', false, '"boardId", "dueAt", "id"', '"archivedAt" IS NULL AND "dueAt" IS NOT NULL'],
    ['activities', 'activities_board_due_date_idx', false, '"boardId", "dueDate", "id"', '"archivedAt" IS NULL AND "dueDate" IS NOT NULL'],
    ['activity_assignments', 'activity_assignments_user_activity_idx', false, '"userId", "activityId"'],
    ['activity_checklist_items', 'activity_checklist_position_unique', true, '"activityId", "position"'],
    ['activity_comments', 'activity_comments_cursor_idx', false, '"activityId", "createdAt", "id"'],
    ['activity_history', 'activity_history_cursor_idx', false, '"activityId", "createdAt", "id"'],
    ['activity_alerts', 'activity_alerts_activity_unique', true, '"activityId"'],
    ['activity_alerts', 'activity_alerts_enabled_schedule_idx', false, '"scheduledAt", "id"', '"enabled" = true'],
    ['activity_deliveries', 'activity_deliveries_schedule_recipient_unique', true, '"alertId", "recipientUserId", "scheduleVersion", "channel"'],
    ['activity_deliveries', 'activity_deliveries_pending_idx', false, '"status", "nextAttemptAt", "id"'],
    ['activity_deliveries', 'activity_deliveries_recipient_read_idx', false, '"recipientUserId", "readAt", "createdAt", "id"'],
    ['activity_operations', 'activity_operations_expiry_idx', false, '"expiresAt"']
];

const contract = {
    tables: Object.keys(tables),
    columns: Object.fromEntries(Object.entries(tables).map(([table, definition]) => [table,
        [...definition.matchAll(/"([A-Za-z][A-Za-z0-9]*)"\s+(?:UUID|VARCHAR|TEXT|INTEGER|BIGINT|TIMESTAMPTZ|BOOLEAN|DATE|JSONB)\b/g)]
            .map(match => match[1])])),
    constraints: [...checks.map(([table, name]) => ({table, name})), ...foreignKeys.map(([table, name]) => ({table, name}))],
    indexes: indexes.map(([table, name, unique, columns, predicate]) => ({table, name, unique,
        columns: columns.replaceAll('"', '').split(',').map(column => column.trim()), predicate: predicate || null}))
};

function validateSchema(schema) {
    if (typeof schema !== 'string' || !schemaPattern.test(schema)) throw new Error('Invalid tenant schema');
}

module.exports = {
    VERSION,
    contract,
    async up(queryInterface, options = {}) {
        const schema = options.schema;
        validateSchema(schema);
        if (!options.transaction) {
            return queryInterface.sequelize.transaction(transaction =>
                module.exports.up(queryInterface, {...options, transaction}));
        }
        const prefix = quote(schema) + '.';
        const run = (sql, replacements = {}) => queryInterface.sequelize.query(sql, {
            transaction: options.transaction, replacements
        });
        await run("SET LOCAL lock_timeout = '10s'");
        // Also protects independently invoked migration runners. It is reentrant in the caller's transaction.
        await run('SELECT pg_advisory_xact_lock(hashtext(:schema), hashtext(:operation))', {
            schema, operation: 'tenant-schema-migrations'
        });
        for (const [table, definition] of Object.entries(tables)) {
            await run(`CREATE TABLE IF NOT EXISTS ${prefix}${quote(table)} (${definition})`);
        }
        const [existingRows] = await run(`SELECT t.relname AS "table", c.conname AS name
            FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = :schema`, {schema});
        const existing = new Set(existingRows.map(row => row.table + '.' + row.name));
        for (const [table, name, expression] of checks) {
            if (existing.has(table + '.' + name)) continue;
            // COALESCE rejects invalid nullable enum combinations; SQL CHECK normally accepts UNKNOWN.
            await run(`ALTER TABLE ${prefix}${quote(table)} ADD CONSTRAINT ${quote(name)} CHECK (COALESCE((${expression}), false))`);
        }
        for (const [table, name, column, target, onDelete] of foreignKeys) {
            if (existing.has(table + '.' + name)) continue;
            await run(`ALTER TABLE ${prefix}${quote(table)} ADD CONSTRAINT ${quote(name)}
                FOREIGN KEY (${quote(column)}) REFERENCES ${prefix}${quote(target)} ("id")
                ON UPDATE CASCADE ON DELETE ${onDelete}`);
        }
        for (const [table, name, unique, columns, predicate] of indexes) {
            await run(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quote(name)}
                ON ${prefix}${quote(table)} (${columns})${predicate ? ' WHERE ' + predicate : ''}`);
        }
        // Public structure rows are visible inside the same registration transaction.
        // Filtering by tenant is essential: a tenant schema must never seed another tenant's premises.
        await run(`INSERT INTO ${prefix}"activity_boards"
            ("id", "structureId", "timezone", "orderRevision", "snapshotRevision", "createdAt", "updatedAt")
            SELECT gen_random_uuid(), s."id", 'Europe/Rome', 0, 0, NOW(), NOW()
            FROM "public"."structures" s
            WHERE replace(s."tenantId"::text, '-', '') = :tenantSuffix
            ON CONFLICT ("structureId") DO NOTHING`, {tenantSuffix: schema.slice('rehablo_'.length).toLowerCase()});
    },
    async down() {
        throw new Error('Activities contain tenant work and cannot be removed automatically.');
    }
};

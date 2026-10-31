'use strict';
const VERSION = '20261031-activity-recurrences';
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const contract = {
    tables: ['activity_executions'],
    columns: {activities: ['currentExecutionId', 'recurrence'], activity_checklist_items: ['executionId'],
        activity_comments: ['executionId'], activity_history: ['executionId'], activity_alerts: ['executionId'],
        activity_deliveries: ['executionId'],
        activity_executions: ['id', 'activityId', 'occurrenceDate', 'boardId', 'title', 'description', 'status', 'priority',
            'position', 'version', 'checklistRevision', 'reviewerUserId', 'reviewStatus', 'reviewApprovedByUserId', 'reviewApprovedAt',
            'dueKind', 'dueAt', 'dueDate', 'dueTimezone', 'createdByUserId', 'updatedByUserId', 'patientId', 'agendaEventId',
            'completedAt', 'completedByUserId', 'archivedAt', 'archivedByUserId', 'reassignmentRequired', 'assigneeIds',
            'closedAt', 'deadlineSnapshot', 'lateUpdatedAt', 'lateUpdatedByUserId', 'createdAt', 'updatedAt']},
    constraints: [{table: 'activity_executions', name: 'activity_executions_state_check'},
        {table: 'activity_executions', name: 'activity_executions_parent_identity_unique'},
        {table: 'activities', name: 'activities_current_execution_fk'},
        ...['activity_checklist_items', 'activity_comments', 'activity_history', 'activity_alerts', 'activity_deliveries']
            .map(table => ({table, name: table + '_execution_fk'}))],
    indexes: [{table: 'activity_executions', name: 'activity_executions_activity_date_unique', unique: true,
            columns: ['activityId', 'occurrenceDate'], predicate: null},
        {table: 'activity_executions', name: 'activity_executions_board_date', unique: false,
            columns: ['boardId', 'occurrenceDate', 'id'], predicate: null},
        ...['activity_checklist_items', 'activity_comments', 'activity_history', 'activity_alerts']
            .map(table => ({table, name: table + '_execution_idx', unique: false, columns: ['activityId', 'executionId'], predicate: null})),
        {table: 'activity_deliveries', name: 'activity_deliveries_execution_idx', unique: false, columns: ['executionId'], predicate: null}]
};

module.exports = {
    VERSION, contract,
    async up(queryInterface, options = {}) {
        const schema = options.schema;
        if (typeof schema !== 'string' || !/^rehablo_[a-f0-9]{32}$/i.test(schema)) throw new Error('Invalid tenant schema');
        if (!options.transaction) return queryInterface.sequelize.transaction(transaction =>
            module.exports.up(queryInterface, {...options, transaction}));
        const run = (sql, replacements = {}) => queryInterface.sequelize.query(sql, {transaction: options.transaction, replacements});
        await run('SELECT pg_advisory_xact_lock(hashtext(:schema), hashtext(:operation))', {schema, operation: 'tenant-schema-migrations'});
        const prefix = quote(schema);
        await run(`ALTER TABLE ${prefix}."activities" ADD COLUMN IF NOT EXISTS "currentExecutionId" UUID NULL,
            ADD COLUMN IF NOT EXISTS "recurrence" JSONB NULL`);
        await run(`CREATE TABLE IF NOT EXISTS ${prefix}."activity_executions" (
            "id" UUID PRIMARY KEY, "activityId" UUID NOT NULL REFERENCES ${prefix}."activities"("id") ON DELETE RESTRICT,
            "occurrenceDate" DATE NOT NULL, "boardId" UUID NOT NULL REFERENCES ${prefix}."activity_boards"("id") ON DELETE RESTRICT,
            "title" VARCHAR(200) NOT NULL, "description" TEXT NULL, "status" VARCHAR(16) NOT NULL DEFAULT 'TODO',
            "priority" VARCHAR(8) NOT NULL DEFAULT 'NORMAL', "position" BIGINT NOT NULL DEFAULT 0,
            "version" INTEGER NOT NULL DEFAULT 1, "checklistRevision" INTEGER NOT NULL DEFAULT 0,
            "reviewerUserId" UUID NULL, "reviewStatus" VARCHAR(16) NOT NULL DEFAULT 'not_requested',
            "reviewApprovedByUserId" UUID NULL, "reviewApprovedAt" TIMESTAMPTZ NULL,
            "dueKind" VARCHAR(8) NOT NULL DEFAULT 'allDay', "dueAt" TIMESTAMPTZ NULL,
            "dueDate" DATE NOT NULL, "dueTimezone" VARCHAR(96) NOT NULL,
            "createdByUserId" UUID NOT NULL, "updatedByUserId" UUID NULL,
            "patientId" UUID NULL, "agendaEventId" UUID NULL,
            "completedAt" TIMESTAMPTZ NULL, "completedByUserId" UUID NULL,
            "archivedAt" TIMESTAMPTZ NULL, "archivedByUserId" UUID NULL,
            "reassignmentRequired" BOOLEAN NOT NULL DEFAULT FALSE,
            "assigneeIds" UUID[] NOT NULL DEFAULT '{}', "closedAt" TIMESTAMPTZ NULL,
            "deadlineSnapshot" JSONB NULL, "lateUpdatedAt" TIMESTAMPTZ NULL, "lateUpdatedByUserId" UUID NULL,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT "activity_executions_parent_identity_unique" UNIQUE ("id", "activityId"),
            CONSTRAINT "activity_executions_state_check" CHECK (
                "status" IN ('TODO','IN_PROGRESS','WAITING','COMPLETED')
                AND "priority" IN ('LOW','NORMAL','HIGH','URGENT') AND "version" > 0 AND "checklistRevision" >= 0
                AND "dueKind" = 'allDay' AND "dueDate" = "occurrenceDate" AND "dueAt" IS NULL
                AND "reviewStatus" IN ('not_requested','pending','approved')
                AND ("reviewStatus" = 'not_requested' OR "reviewerUserId" IS NOT NULL)
                AND (("reviewStatus" = 'approved' AND "reviewApprovedAt" IS NOT NULL AND "reviewApprovedByUserId" IS NOT NULL)
                    OR ("reviewStatus" <> 'approved' AND "reviewApprovedAt" IS NULL AND "reviewApprovedByUserId" IS NULL))
                AND (("closedAt" IS NULL AND "deadlineSnapshot" IS NULL) OR ("closedAt" IS NOT NULL AND "deadlineSnapshot" IS NOT NULL)))
        )`);
        await run(`CREATE UNIQUE INDEX IF NOT EXISTS "activity_executions_activity_date_unique" ON ${prefix}."activity_executions" ("activityId", "occurrenceDate")`);
        await run(`CREATE INDEX IF NOT EXISTS "activity_executions_board_date" ON ${prefix}."activity_executions" ("boardId", "occurrenceDate" DESC, "id" DESC)`);
        const addConstraint = async (table, name, sql) => {
            const [rows] = await run(`SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
                JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=:schema AND t.relname=:table AND c.conname=:name`, {schema, table, name});
            if (!rows.length) await run(`ALTER TABLE ${prefix}.${quote(table)} ADD CONSTRAINT ${quote(name)} ${sql}`);
        };
        await addConstraint('activities', 'activities_current_execution_fk',
            `FOREIGN KEY ("currentExecutionId", "id") REFERENCES ${prefix}."activity_executions"("id", "activityId") ON DELETE RESTRICT`);
        for (const table of ['activity_checklist_items', 'activity_comments', 'activity_history', 'activity_alerts']) {
            await run(`ALTER TABLE ${prefix}.${quote(table)} ADD COLUMN IF NOT EXISTS "executionId" UUID NULL`);
            await addConstraint(table, table + '_execution_fk',
                `FOREIGN KEY ("executionId", "activityId") REFERENCES ${prefix}."activity_executions"("id", "activityId") ON DELETE RESTRICT`);
            await run(`CREATE INDEX IF NOT EXISTS ${quote(table + '_execution_idx')} ON ${prefix}.${quote(table)} ("activityId", "executionId")`);
        }
        // Deliveries retain their own day even when the activity's single alert is rescheduled.
        await run(`ALTER TABLE ${prefix}."activity_deliveries" ADD COLUMN IF NOT EXISTS "executionId" UUID NULL`);
        await addConstraint('activity_deliveries', 'activity_deliveries_execution_fk',
            `FOREIGN KEY ("executionId") REFERENCES ${prefix}."activity_executions"("id") ON DELETE RESTRICT`);
        await run(`CREATE INDEX IF NOT EXISTS "activity_deliveries_execution_idx" ON ${prefix}."activity_deliveries" ("executionId")`);
        // Retain the legacy index name and ordinary-task invariant while allowing each day its own ordering.
        await run(`DROP INDEX IF EXISTS ${prefix}."activity_checklist_position_unique"`);
        await run(`CREATE UNIQUE INDEX "activity_checklist_position_unique" ON ${prefix}."activity_checklist_items"
            ("activityId", COALESCE("executionId", '00000000-0000-0000-0000-000000000000'::uuid), "position")`);
    },
    async down() { throw new Error('Execution history cannot be removed automatically; use a reviewed corrective migration.'); }
};

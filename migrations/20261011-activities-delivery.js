'use strict';
const VERSION = '20261011-activities-delivery';
const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
const contract = {
    tables: ['activity_notification_activation', 'activity_push_targets'],
    columns: {activity_deliveries: ['dispatchStartedAt'], activity_notification_activation: ['key', 'activatedAt'],
        activity_push_targets: ['id', 'deliveryId', 'subscriptionId', 'endpointHash', 'status', 'attempts', 'nextAttemptAt',
            'dispatchStartedAt', 'lastError', 'providerReference', 'sentAt', 'createdAt', 'updatedAt']},
    constraints: [{table: 'activity_push_targets', name: 'activity_push_targets_delivery_fkey'},
        {table: 'activity_push_targets', name: 'activity_push_targets_status_check'},
        {table: 'activity_push_targets', name: 'activity_push_targets_attempts_check'}],
    indexes: [{table: 'activity_push_targets', name: 'activity_push_targets_device_unique', unique: true,
        columns: ['deliveryId', 'subscriptionId'], predicate: null}]
};
module.exports = {
    VERSION, contract,
    async up(queryInterface, options = {}) {
        const schema = options.schema;
        if (typeof schema !== 'string' || !/^rehablo_[a-f0-9]{32}$/i.test(schema)) throw new Error('Invalid tenant schema');
        if (!options.transaction) return queryInterface.sequelize.transaction(transaction =>
            module.exports.up(queryInterface, {...options, transaction}));
        const prefix = quote(schema) + '.';
        const run = (sql, replacements = {}) => queryInterface.sequelize.query(sql, {transaction: options.transaction, replacements});
        await run('SELECT pg_advisory_xact_lock(hashtext(:schema), hashtext(:operation))', {schema, operation: 'tenant-schema-migrations'});
        await run(`ALTER TABLE ${prefix}"activity_deliveries" ADD COLUMN IF NOT EXISTS "dispatchStartedAt" TIMESTAMPTZ NULL`);
        await run(`CREATE TABLE IF NOT EXISTS ${prefix}"activity_notification_activation" (
            "key" VARCHAR(32) PRIMARY KEY, "activatedAt" TIMESTAMPTZ NOT NULL)`);
        await run(`CREATE TABLE IF NOT EXISTS ${prefix}"activity_push_targets" (
            "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "deliveryId" UUID NOT NULL, "subscriptionId" UUID NOT NULL,
            "endpointHash" VARCHAR(64) NOT NULL, "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
            "attempts" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMPTZ NOT NULL,
            "dispatchStartedAt" TIMESTAMPTZ NULL, "lastError" VARCHAR(255) NULL, "providerReference" VARCHAR(255) NULL,
            "sentAt" TIMESTAMPTZ NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        const [existing] = await run(`SELECT c.conname AS name FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = :schema AND t.relname = 'activity_push_targets'`, {schema});
        const names = new Set(existing.map(row => row.name));
        const constraints = [
            ['activity_push_targets_delivery_fkey', `FOREIGN KEY ("deliveryId") REFERENCES ${prefix}"activity_deliveries" ("id") ON DELETE CASCADE`],
            ['activity_push_targets_status_check', `CHECK ("status" IN ('PENDING','PROCESSING','SENT','FAILED','CANCELLED','UNCERTAIN'))`],
            ['activity_push_targets_attempts_check', 'CHECK ("attempts" >= 0)']
        ];
        for (const [name, definition] of constraints) if (!names.has(name))
            await run(`ALTER TABLE ${prefix}"activity_push_targets" ADD CONSTRAINT ${quote(name)} ${definition}`);
        await run(`CREATE UNIQUE INDEX IF NOT EXISTS "activity_push_targets_device_unique"
            ON ${prefix}"activity_push_targets" ("deliveryId", "subscriptionId")`);
        // No activation row, no deliveries and no provider calls are introduced by this migration.
    },
    async down() {throw new Error('Delivery receipts cannot be removed automatically.');}
};

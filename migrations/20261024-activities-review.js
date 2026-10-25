'use strict';
const VERSION = '20261024-activities-review';
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const contract = {
    tables: [], columns: {activities: ['reviewerUserId', 'reviewStatus', 'reviewApprovedByUserId', 'reviewApprovedAt']},
    constraints: [{table: 'activities', name: 'activities_review_state_check'}], indexes: []
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
        const table = quote(schema) + '."activities"';
        await run(`ALTER TABLE ${table}
            ADD COLUMN IF NOT EXISTS "reviewerUserId" UUID NULL,
            ADD COLUMN IF NOT EXISTS "reviewStatus" VARCHAR(16) NOT NULL DEFAULT 'not_requested',
            ADD COLUMN IF NOT EXISTS "reviewApprovedByUserId" UUID NULL,
            ADD COLUMN IF NOT EXISTS "reviewApprovedAt" TIMESTAMPTZ NULL`);
        const [rows] = await run(`SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = :schema
            AND t.relname = 'activities' AND c.conname = 'activities_review_state_check'`, {schema});
        if (!rows.length) await run(`ALTER TABLE ${table} ADD CONSTRAINT "activities_review_state_check" CHECK (
            "reviewStatus" IN ('not_requested', 'pending', 'approved')
            AND ("reviewStatus" = 'not_requested' OR "reviewerUserId" IS NOT NULL)
            AND (("reviewStatus" = 'approved' AND "reviewApprovedAt" IS NOT NULL AND "reviewApprovedByUserId" IS NOT NULL)
                OR ("reviewStatus" <> 'approved' AND "reviewApprovedAt" IS NULL AND "reviewApprovedByUserId" IS NULL)))`);
    },
    async down() {throw new Error('Review history cannot be removed automatically.');}
};

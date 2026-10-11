'use strict';
const VERSION = '20261011-activities-notifications-public';
const contract = {
    tables: ['activity_notification_preferences'],
    columns: {
        activity_notification_preferences: ['userId', 'emailEnabled', 'emailEnabledAt', 'createdAt', 'updatedAt'],
        reminder_push_subscriptions: ['remindersEnabled', 'activitiesEnabled', 'activitiesEnabledAt']
    }
};
module.exports = {
    VERSION, contract,
    async up(queryInterface, options = {}) {
        if (!options.transaction) return queryInterface.sequelize.transaction(transaction =>
            module.exports.up(queryInterface, {...options, transaction}));
        const run = sql => queryInterface.sequelize.query(sql, {transaction: options.transaction});
        await run("SELECT pg_advisory_xact_lock(hashtext('public'), hashtext('activities-notifications-public'))");
        await run(`CREATE TABLE IF NOT EXISTS "public"."activity_notification_preferences" (
            "userId" UUID PRIMARY KEY, "emailEnabled" BOOLEAN NOT NULL DEFAULT false, "emailEnabledAt" TIMESTAMPTZ NULL,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await run(`ALTER TABLE "public"."reminder_push_subscriptions"
            ADD COLUMN IF NOT EXISTS "remindersEnabled" BOOLEAN NOT NULL DEFAULT true,
            ADD COLUMN IF NOT EXISTS "activitiesEnabled" BOOLEAN NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS "activitiesEnabledAt" TIMESTAMPTZ NULL`);
        await run(`CREATE INDEX IF NOT EXISTS "shared_push_activity_user_idx" ON "public"."reminder_push_subscriptions"
            ("userId", "activitiesEnabled")`);
        await run(`CREATE TABLE IF NOT EXISTS "public"."activity_notification_migrations" (
            "version" VARCHAR(160) PRIMARY KEY, "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await queryInterface.sequelize.query(`INSERT INTO "public"."activity_notification_migrations" ("version")
            VALUES (:version) ON CONFLICT ("version") DO NOTHING`, {transaction: options.transaction, replacements: {version: VERSION}});
    },
    async down() {throw new Error('Notification preferences cannot be removed automatically.');}
};

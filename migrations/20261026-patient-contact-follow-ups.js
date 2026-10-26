'use strict';
module.exports = {
    async up(queryInterface, {schema, transaction}) {
        if (!/^rehablo_[a-f0-9]{32}$/i.test(schema)) throw new Error('Invalid tenant schema');
        const prefix = `"${schema}"`;
        await queryInterface.sequelize.query(`ALTER TABLE ${prefix}."reminders" ADD COLUMN IF NOT EXISTS "sourceType" VARCHAR(40)`, {transaction});
        await queryInterface.sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS "reminders_personal_contacts_active_unique"
            ON ${prefix}."reminders" ("createdByUserId", "patientId", "structureId")
            WHERE "sourceType"='PATIENT_MISSING_CONTACTS' AND "status" IN ('OPEN','SNOOZED') AND "deletedAt" IS NULL`, {transaction});
        await queryInterface.sequelize.query(`CREATE TABLE IF NOT EXISTS ${prefix}."patient_contact_follow_ups" (
            "userId" UUID NOT NULL, "patientId" UUID NOT NULL, "structureId" UUID NOT NULL,
            "suppressedAt" TIMESTAMPTZ NULL, "reminderId" UUID NULL,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY ("userId", "patientId", "structureId"))`, {transaction});
    }
};

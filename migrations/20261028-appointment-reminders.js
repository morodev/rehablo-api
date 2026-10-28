'use strict';

module.exports = {
    async up(queryInterface, {schema, transaction}) {
        if (!/^rehablo_[a-f0-9]{32}$/i.test(schema)) throw new Error('Invalid tenant schema');
        const prefix = '"' + schema + '"';
        await queryInterface.sequelize.query(`CREATE TABLE IF NOT EXISTS ${prefix}."appointment_reminder_deliveries" (
            "id" UUID PRIMARY KEY, "sequence" BIGSERIAL UNIQUE NOT NULL, "agendaEventId" UUID NOT NULL,
            "occurrenceKey" VARCHAR(40) NOT NULL, "occurrenceStart" TIMESTAMPTZ NULL,
            "structureId" UUID NULL, "patientId" UUID NOT NULL,
            "channel" VARCHAR(16) NOT NULL CHECK ("channel" IN ('email','whatsapp')),
            "recipient" VARCHAR(320) NOT NULL, "message" TEXT NOT NULL, "snapshotHash" VARCHAR(64) NOT NULL,
            "status" VARCHAR(16) NOT NULL CHECK ("status" IN ('PREPARED','PENDING','SENT','OPENED','FAILED','UNKNOWN')),
            "requestedBy" UUID NOT NULL, "idempotencyKey" VARCHAR(128) NULL,
            "sentAt" TIMESTAMPTZ NULL, "openedAt" TIMESTAMPTZ NULL, "lastError" TEXT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL, "updatedAt" TIMESTAMPTZ NOT NULL
        )`, {transaction});
        await queryInterface.sequelize.query(`CREATE INDEX IF NOT EXISTS "appointment_reminder_occurrence_idx"
            ON ${prefix}."appointment_reminder_deliveries" ("agendaEventId","occurrenceKey","createdAt")`, {transaction});
        await queryInterface.sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS "appointment_reminder_request_unique"
            ON ${prefix}."appointment_reminder_deliveries" ("agendaEventId","occurrenceKey","channel","idempotencyKey")`, {transaction});
    }
};

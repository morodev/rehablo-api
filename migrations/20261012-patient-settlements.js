'use strict';
const VERSION = '20261012-patient-settlements';
module.exports = {
    VERSION,
    async up(queryInterface, options = {}) {
        if (!/^rehablo_[a-f0-9]{32}$/i.test(options.schema ?? '')) throw new Error('Invalid tenant schema');
        const prefix = '"' + options.schema + '".';
        const run = sql => queryInterface.sequelize.query(sql, {transaction: options.transaction});
        await run(`CREATE TABLE IF NOT EXISTS ${prefix}"patient_settlement_operations" (
            "id" UUID PRIMARY KEY,
            "patientId" UUID NOT NULL,
            "structureId" UUID NOT NULL,
            "idempotencyKey" VARCHAR(128) NOT NULL,
            "requestHash" VARCHAR(64) NOT NULL,
            "result" JSONB NOT NULL,
            "createdByUserId" UUID NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await run(`CREATE UNIQUE INDEX IF NOT EXISTS "patient_settlement_operations_key_unique"
            ON ${prefix}"patient_settlement_operations" ("idempotencyKey")`);
        await run(`CREATE INDEX IF NOT EXISTS "patient_settlement_operations_patient_date_idx"
            ON ${prefix}"patient_settlement_operations" ("patientId", "structureId", "createdAt")`);
    },
    async down() {throw new Error('Financial retry records are immutable. Automatic removal is not supported.');}
};

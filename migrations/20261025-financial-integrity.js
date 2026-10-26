'use strict';

/** Additive schema only. No historical financial records are changed. */
module.exports = {
    async up(queryInterface, {schema, transaction}) {
        if (!/^rehablo_[a-f0-9]{32}$/i.test(schema)) throw new Error('Invalid tenant schema');
        const prefix = `"${schema}"`;
        await queryInterface.sequelize.query(`CREATE TABLE IF NOT EXISTS ${prefix}."financial_operations" (
            "id" UUID PRIMARY KEY,
            "idempotencyKey" VARCHAR(128) NOT NULL,
            "kind" VARCHAR(64) NOT NULL,
            "requestHash" VARCHAR(64) NOT NULL,
            "createdByUserId" UUID NOT NULL,
            "structureId" UUID NOT NULL,
            "result" JSONB NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`, {transaction});
        await queryInterface.sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS "financial_operations_key_unique"
            ON ${prefix}."financial_operations" ("idempotencyKey")`, {transaction});
    }
};

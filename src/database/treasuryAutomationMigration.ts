import type {Sequelize, Transaction} from 'sequelize';
import {quoteTenantSchema} from './migrationTypes.js';

/** Additive business metadata only. No old payment, amount, date or balance is rewritten. */
export async function migrateTreasuryAutomationTenant(database: Sequelize, schema: string, transaction: Transaction): Promise<void> {
    const prefix = quoteTenantSchema(schema);
    const run = (sql: string) => database.query(sql, {transaction});
    await run(`ALTER TABLE ${prefix}."treasury_classifications"
        ALTER COLUMN "updatedByUserId" DROP NOT NULL,
        ADD COLUMN IF NOT EXISTS "allocations" JSONB NULL,
        ADD COLUMN IF NOT EXISTS "origin" VARCHAR(24) NOT NULL DEFAULT 'MANUAL',
        ADD COLUMN IF NOT EXISTS "sourceKind" VARCHAR(24) NULL,
        ADD COLUMN IF NOT EXISTS "sourceId" VARCHAR(100) NULL`);
    await run(`CREATE INDEX IF NOT EXISTS "treasury_classifications_source_idx" ON ${prefix}."treasury_classifications" ("sourceKind","sourceId")`);
    await run(`CREATE TABLE IF NOT EXISTS ${prefix}."treasury_category_defaults" (
        "sourceKind" VARCHAR(24) NOT NULL, "sourceId" VARCHAR(100) NOT NULL,
        "businessCategoryId" UUID NULL REFERENCES ${prefix}."treasury_categories"("id") ON DELETE RESTRICT,
        "updatedByUserId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY ("sourceKind","sourceId")
    )`);
    await run(`CREATE TABLE IF NOT EXISTS ${prefix}."treasury_category_snapshots" (
        "sourceKind" VARCHAR(24) NOT NULL, "sourceId" VARCHAR(100) NOT NULL, "weights" JSONB NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY ("sourceKind","sourceId")
    )`);
}

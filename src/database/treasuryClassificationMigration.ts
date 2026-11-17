import type {Sequelize, Transaction} from 'sequelize';
import {quoteTenantSchema} from './migrationTypes.js';

/** Additive metadata only: existing ledger rows, financial categories and balances are untouched. */
export async function migrateTreasuryClassificationTenant(database: Sequelize, schema: string, transaction: Transaction): Promise<void> {
    const prefix = quoteTenantSchema(schema);
    const run = (sql: string) => database.query(sql, {transaction});
    await run(`CREATE TABLE IF NOT EXISTS ${prefix}."treasury_categories" (
        "id" UUID PRIMARY KEY, "name" VARCHAR(100) NOT NULL,
        "normalizedName" VARCHAR(100) NOT NULL UNIQUE,
        "direction" VARCHAR(3) NOT NULL CHECK ("direction" IN ('IN','OUT')),
        "color" VARCHAR(7) NOT NULL DEFAULT '#6366f1' CHECK ("color" ~ '^#[a-fA-F0-9]{6}$'),
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await run(`CREATE TABLE IF NOT EXISTS ${prefix}."treasury_tags" (
        "id" UUID PRIMARY KEY, "name" VARCHAR(100) NOT NULL,
        "normalizedName" VARCHAR(100) NOT NULL UNIQUE,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await run(`CREATE TABLE IF NOT EXISTS ${prefix}."treasury_classifications" (
        "movementId" UUID PRIMARY KEY REFERENCES ${prefix}."treasury_movements"("id") ON DELETE RESTRICT,
        "businessCategoryId" UUID NULL REFERENCES ${prefix}."treasury_categories"("id") ON DELETE RESTRICT,
        "updatedByUserId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await run(`CREATE INDEX IF NOT EXISTS "treasury_classifications_category_idx" ON ${prefix}."treasury_classifications" ("businessCategoryId")`);
    await run(`CREATE TABLE IF NOT EXISTS ${prefix}."treasury_movement_tags" (
        "movementId" UUID NOT NULL REFERENCES ${prefix}."treasury_classifications"("movementId") ON DELETE RESTRICT,
        "tagId" UUID NOT NULL REFERENCES ${prefix}."treasury_tags"("id") ON DELETE RESTRICT,
        PRIMARY KEY ("movementId", "tagId")
    )`);
    await run(`CREATE INDEX IF NOT EXISTS "treasury_movement_tags_tag_idx" ON ${prefix}."treasury_movement_tags" ("tagId", "movementId")`);
}

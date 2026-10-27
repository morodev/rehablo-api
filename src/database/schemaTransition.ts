import type {Sequelize, Transaction} from 'sequelize';
import {SchemaReadinessError} from './migrationTypes.js';

/** Created by predeploy, never by the API. Only bridge-aware binaries confirm the transition. */
export async function initializeBridge(database: Sequelize, transaction: Transaction): Promise<void> {
    await database.query(`CREATE TABLE IF NOT EXISTS public.schema_transition (
        "key" VARCHAR(80) PRIMARY KEY, "completedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`, {transaction});
}

export async function markBridgeComplete(database: Sequelize): Promise<void> {
    await database.query(`INSERT INTO public.schema_transition ("key") VALUES ('20261028-schema-bridge-v1')
        ON CONFLICT ("key") DO NOTHING`);
}

export async function requireBridgeComplete(database: Sequelize): Promise<void> {
    const [tables] = await database.query("SELECT to_regclass('public.tenants') AS tenants,to_regclass('public.schema_transition') AS transition");
    const existing = tables[0] as {tenants?: string; transition?: string};
    if (!existing.tenants) return;
    const [tenants] = await database.query('SELECT 1 FROM public.tenants LIMIT 1');
    if (!tenants.length) return;
    if (existing.transition) {
        const [rows] = await database.query("SELECT 1 FROM public.schema_transition WHERE key='20261028-schema-bridge-v1'");
        if (rows.length) return;
    }
    throw new SchemaReadinessError('Deploy the bridge configuration first and retire all pre-bridge instances before the managed release');
}

import { ModelStatic } from 'sequelize';
import { sequelize } from '../config/database.js';

/**
 * Builds the dynamic Postgres schema name used for tenant-scoped business data.
 * Mirrors the naming convention already used in production: "rehablo_<tenantId without dashes>".
 */
export function getTenantSchemaName(tenantId: string): string {
    return 'rehablo_' + tenantId.replaceAll('-', '');
}

/**
 * Every module registers here the models that live in the per-tenant dynamic schema
 * (patients, products, services, invoices, agenda events...). They get synced automatically
 * the first time a tenant schema is created/accessed, instead of calling `.sync()` on every
 * single request like the legacy microservices used to do.
 */
const tenantScopedModels: ModelStatic<any>[] = [];

export function registerTenantScopedModel(model: ModelStatic<any>): void {
    tenantScopedModels.push(model);
}

const ensuredSchemas = new Set<string>();

/**
 * Ensures the tenant schema exists and all tenant-scoped models are synced into it.
 * Cached in-process so repeated requests don't hit Postgres with CREATE SCHEMA / sync every time.
 */
export async function ensureTenantSchema(tenantId: string): Promise<string> {
    const schemaName = getTenantSchemaName(tenantId);

    if (!ensuredSchemas.has(schemaName)) {
        await sequelize.createSchema(schemaName, {});

        for (const model of tenantScopedModels) {
            await model.schema(schemaName).sync({ alter: true });
        }

        ensuredSchemas.add(schemaName);
    }

    return schemaName;
}



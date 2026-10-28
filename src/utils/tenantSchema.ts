import type { ModelStatic, Transaction } from 'sequelize';
import { sequelize } from '../config/database.js';
import {databaseManifest} from '../database/migrationManifest.js';
import {assertProvisioningRelease, assertTenantReady, lockProvisioning, recordTenantReady} from '../database/releaseControl.js';
import {runTenantMigrations as applyVersionedTenantMigrations} from '../database/releaseRunner.js';
import {ensureActivityDeliveryActivation} from '../modules/activities/services/activityDeliveryActivation.service.js';

/**
 * Builds the dynamic Postgres schema name used for tenant-scoped business data.
 * Mirrors the naming convention already used in production: "rehablo_<tenantId without dashes>".
 */
export function getTenantSchemaName(tenantId: string): string {
    return 'rehablo_' + tenantId.replaceAll('-', '');
}

/**
 * Every module registers here the models that live in the per-tenant dynamic schema
 * (patients, products, services, invoices, agenda events...). Managed requests only check
 * the central compatibility record. Schema changes belong to versioned migrations.
 */
const tenantScopedModels: ModelStatic<any>[] = [];

export function registerTenantScopedModel(model: ModelStatic<any>): void {
    if (!tenantScopedModels.includes(model)) tenantScopedModels.push(model);
}

export function getTenantScopedModels(): readonly ModelStatic<any>[] {
    return tenantScopedModels;
}

const ensuredSchemas = new Set<string>();

/**
 * Share the readiness lookup between simultaneous requests. Cache a schema only after its
 * persisted compatibility record has been verified successfully.
 */
const inFlightSchemas = new Map<string, Promise<string>>();

/**
 * Checks tenant compatibility, cached in-process. Managed requests never repair or create tables.
 */
export async function ensureTenantSchema(tenantId: string): Promise<string> {
    const schemaName = getTenantSchemaName(tenantId);

    if (ensuredSchemas.has(schemaName)) {
        return schemaName;
    }

    const pending = inFlightSchemas.get(schemaName);
    if (pending) {
        return pending;
    }

    const task = checkTenantSchema(schemaName).finally(() => {
        inFlightSchemas.delete(schemaName);
    });

    inFlightSchemas.set(schemaName, task);

    return task;
}

async function checkTenantSchema(schemaName: string): Promise<string> {
    await assertTenantReady(schemaName, databaseManifest, sequelize);
    ensuredSchemas.add(schemaName);
    return schemaName;
}

/** Provision a tenant in the caller's transaction, used during registration before it is returned. */
export async function beginTenantProvisioning(transaction: Transaction): Promise<void> {
    await lockProvisioning(sequelize, transaction);
    await assertProvisioningRelease(databaseManifest, sequelize, transaction);
}

export async function provisionTenantSchema(tenantId: string, transaction: Transaction): Promise<string> {
    const schemaName = getTenantSchemaName(tenantId);
    await beginTenantProvisioning(transaction);
    await applyVersionedTenantMigrations(databaseManifest, schemaName, sequelize, transaction);
    // Activation belongs to runtime enablement, not to migration time while delivery is disabled.
    await ensureActivityDeliveryActivation(schemaName, transaction);
    await recordTenantReady(schemaName, databaseManifest, sequelize, transaction);
    return schemaName;
}

/** Mark a schema provisioned in a transaction that has just committed successfully. */
export function markTenantSchemaReady(tenantId: string): void {
    ensuredSchemas.add(getTenantSchemaName(tenantId));
}

/**
 * Read-only compatibility checks for a known tenant list. Startup migration discovery is
 * handled by the release runner, so this helper never synchronizes or changes schemas.
 */
export async function warmTenantSchemas(tenantIds: string[], concurrency = 2): Promise<number> {
    const uniqueTenantIds = [...new Set(tenantIds)];
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Tenant bootstrap concurrency must be positive');
    let cursor = 0;
    const worker = async () => {
        while (cursor < uniqueTenantIds.length) {
            const index = cursor++;
            await ensureTenantSchema(uniqueTenantIds[index]);
        }
    };
    await Promise.all(Array.from({length: Math.min(concurrency, uniqueTenantIds.length)}, worker));
    return uniqueTenantIds.length;
}

/**
 * Invalidates the local compatibility cache; managed access repeats only the read-only check.
 */
export function invalidateTenantSchemaCache(tenantId?: string): void {
    if (tenantId) {
        ensuredSchemas.delete(getTenantSchemaName(tenantId));
        return;
    }
    ensuredSchemas.clear();
}



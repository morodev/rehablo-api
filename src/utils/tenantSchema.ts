import { ModelStatic, SyncOptions, Transaction } from 'sequelize';
import { sequelize } from '../config/database.js';
import { env } from '../config/env.js';
import {bridgeManifest, databaseManifest} from '../database/migrationManifest.js';
import {assertProvisioningRelease, assertTenantReady, lockProvisioning, recordTenantReady, withSharedReleaseLock} from '../database/releaseControl.js';
import {getDatabaseStatus, runTenantMigrations as applyVersionedTenantMigrations} from '../database/releaseRunner.js';
import {SchemaReadinessError} from '../database/migrationTypes.js';
import {ensureActivityDeliveryActivation} from '../modules/activities/services/activityDeliveryActivation.service.js';
import {
    isTenantSchemaCurrent, lockTenantSchema, prepareTenantPaymentHistory,
    recordTenantModelBaseline, runTenantMigrations, traceTenantSchemaPhase
} from './tenantMigrations.js';

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
 * the central compatibility record. Model sync is confined to the ordered bridge release.
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
 * Sync già in corso per uno schema. `ensuredSchemas` viene popolata solo A FINE sync: senza
 * questa mappa, le richieste che arrivano insieme subito dopo un riavvio lancerebbero ognuna
 * il sync completo di ~30 modelli sullo stesso schema, in concorrenza fra loro.
 */
const inFlightSchemas = new Map<string, Promise<string>>();

/**
 * Opzioni di sync per i modelli tenant, secondo `TENANT_SCHEMA_SYNC`.
 *
 * `alter: { drop: false }` è la modalità additiva: Sequelize esegue il solo ciclo di `addColumn`
 * per le colonne mancanti e salta INTERAMENTE il ciclo che rimuove colonne, droppa foreign key e
 * riscrive i tipi (vedi `sequelize/lib/model.js`: `options.alter === true || options.alter.drop !== false`).
 *
 * È esattamente quel secondo ciclo a rompersi in multi-tenant: per risolvere le foreign key
 * Sequelize usa `SELECT oid FROM pg_class WHERE relname = '<tabella>' LIMIT 1` senza filtrare
 * per schema, quindi legge i vincoli di un tenant arbitrario e prova a droppare quei nomi sullo
 * schema corrente, dove non esistono (`SequelizeUnknownConstraintError`, SQLSTATE 42704).
 * Ed è comunque un ciclo da tenere spento in produzione: elimina senza chiedere le colonne non
 * più dichiarate nel modello.
 */
function syncOptionsFor(): SyncOptions | null {
    switch (env.tenantSchemaSync) {
        case 'off':
            return null;
        case 'full':
            return { alter: true };
        case 'additive':
        default:
            return { alter: { drop: false } };
    }
}

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

    const task = syncTenantSchema(schemaName).finally(() => {
        inFlightSchemas.delete(schemaName);
    });

    inFlightSchemas.set(schemaName, task);

    return task;
}

async function syncTenantSchema(schemaName: string): Promise<string> {
    if (env.databaseMigrationPhase === 'managed') {
        await assertTenantReady(schemaName, databaseManifest, sequelize);
        ensuredSchemas.add(schemaName);
        return schemaName;
    }
    return withSharedReleaseLock(sequelize, () => traceTenantSchemaPhase(schemaName, 'bridge tenant', async () => {
        // A still-running bridge instance may serve existing tenants after the managed predeploy.
        // It must never synchronize those schemas back to its legacy model baseline.
        if ((await getDatabaseStatus(databaseManifest, sequelize)).ready) {
            await assertTenantReady(schemaName, databaseManifest, sequelize);
            ensuredSchemas.add(schemaName);
            return schemaName;
        }
        const syncOptions = syncOptionsFor();
        if (!syncOptions && !await isTenantSchemaCurrent(schemaName)) {
            throw new SchemaReadinessError(`Legacy tenant schema ${schemaName} is incomplete; use the release migration runner`);
        }
        if (syncOptions && !await isTenantSchemaCurrent(schemaName)) {
            await traceTenantSchemaPhase(schemaName, 'transazione schema', () =>
                sequelize.transaction(transaction => initializeTenantSchema(schemaName, syncOptions, transaction, true)));
        }
        await traceTenantSchemaPhase(schemaName, 'attivazione notifiche', () => ensureActivityDeliveryActivation(schemaName));
        await sequelize.transaction(transaction => recordTenantReady(schemaName, bridgeManifest, sequelize, transaction));
        ensuredSchemas.add(schemaName);
        return schemaName;
    }));
}

async function initializeTenantSchema(
    schemaName: string, syncOptions: SyncOptions, transaction: Transaction, recheckCurrent = false
): Promise<void> {
    await lockTenantSchema(sequelize, schemaName, transaction);
    // A second API instance can complete the same tenant while this one waits for the lock.
    if (recheckCurrent && await isTenantSchemaCurrent(schemaName, sequelize, transaction)) return;
    await traceTenantSchemaPhase(schemaName, 'creazione schema', () =>
        sequelize.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`, {transaction}));
    const repairHistoryKnown = await traceTenantSchemaPhase(schemaName, 'preparazione storico pagamenti', () =>
        prepareTenantPaymentHistory(schemaName, sequelize, transaction));
    // Schema sync and versioned migrations commit together. A failure keeps the tenant out of
    // the ready cache and prevents requests from observing a partially upgraded schema.
    const transactionalSyncOptions = {...syncOptions, transaction} as SyncOptions;
    for (const [index, model] of tenantScopedModels.entries()) {
        // Sequelize forwards unknown SyncOptions to every QueryInterface call; its v6 typings
        // omit `transaction`, although the runtime supports and propagates it.
        const modelName = model.name || model.tableName || `#${index + 1}`;
        await traceTenantSchemaPhase(schemaName, `sync modello ${modelName}`, () =>
            model.schema(schemaName).sync(transactionalSyncOptions));
    }
    const completed = await runTenantMigrations(schemaName, repairHistoryKnown, sequelize, transaction);
    if (completed.length) {
        console.log(`[tenant-schema] ${schemaName}: migrazioni completate (${completed.join(', ')})`);
    }
    await traceTenantSchemaPhase(schemaName, 'registrazione baseline modelli', () =>
        recordTenantModelBaseline(schemaName, sequelize, transaction));
    await traceTenantSchemaPhase(schemaName, 'attivazione notifiche nella transazione', () =>
        ensureActivityDeliveryActivation(schemaName, transaction));
}

/** Provision a tenant in the caller's transaction, used during registration before it is returned. */
export async function beginTenantProvisioning(transaction: Transaction): Promise<void> {
    await lockProvisioning(sequelize, transaction);
    if (env.databaseMigrationPhase === 'managed') {
        await assertProvisioningRelease(databaseManifest, sequelize, transaction);
    } else if ((await getDatabaseStatus(databaseManifest, sequelize)).ready) {
        throw new SchemaReadinessError('Registration is waiting for the managed API release');
    }
}

export async function provisionTenantSchema(tenantId: string, transaction: Transaction): Promise<string> {
    const schemaName = getTenantSchemaName(tenantId);
    await beginTenantProvisioning(transaction);
    if (env.databaseMigrationPhase === 'managed') {
        await applyVersionedTenantMigrations(databaseManifest, schemaName, sequelize, transaction);
        // Activation belongs to runtime enablement, not to migration time while delivery is disabled.
        await ensureActivityDeliveryActivation(schemaName, transaction);
        await recordTenantReady(schemaName, databaseManifest, sequelize, transaction);
        return schemaName;
    }
    return traceTenantSchemaPhase(schemaName, 'provisioning tenant', async () => {
        const syncOptions = syncOptionsFor();
        if (!syncOptions) throw new SchemaReadinessError('Bridge provisioning requires TENANT_SCHEMA_SYNC=additive');
        await initializeTenantSchema(schemaName, syncOptions, transaction);
        await recordTenantReady(schemaName, bridgeManifest, sequelize, transaction);
        return schemaName;
    });
}

/** Mark a schema provisioned in a transaction that has just committed successfully. */
export function markTenantSchemaReady(tenantId: string): void {
    ensuredSchemas.add(getTenantSchemaName(tenantId));
}

/**
 * Bridge-only warmup. Managed startup does not call this function or enumerate tenant schemas.
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



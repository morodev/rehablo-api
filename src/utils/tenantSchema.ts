import { ModelStatic, SyncOptions, Transaction } from 'sequelize';
import { sequelize } from '../config/database.js';
import { env } from '../config/env.js';
import {
    isTenantSchemaCurrent, lockTenantSchema, prepareTenantPaymentHistory,
    recordTenantModelBaseline, runTenantMigrations
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
 * Ensures the tenant schema exists and all tenant-scoped models are synced into it.
 * Cached in-process so repeated requests don't hit Postgres with CREATE SCHEMA / sync every time.
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
    const syncOptions = syncOptionsFor();
    if (syncOptions && !await isTenantSchemaCurrent(schemaName)) {
        await sequelize.transaction(transaction => initializeTenantSchema(schemaName, syncOptions, transaction, true));
    }
    ensuredSchemas.add(schemaName);
    return schemaName;
}

async function initializeTenantSchema(
    schemaName: string, syncOptions: SyncOptions, transaction: Transaction, recheckCurrent = false
): Promise<void> {
    await lockTenantSchema(sequelize, schemaName, transaction);
    // A second API instance can complete the same tenant while this one waits for the lock.
    if (recheckCurrent && await isTenantSchemaCurrent(schemaName, sequelize, transaction)) return;
    await sequelize.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`, {transaction});
    const repairHistoryKnown = await prepareTenantPaymentHistory(schemaName, sequelize, transaction);
    // Schema sync and versioned migrations commit together. A failure keeps the tenant out of
    // the ready cache and prevents requests from observing a partially upgraded schema.
    const transactionalSyncOptions = {...syncOptions, transaction} as SyncOptions;
    for (const model of tenantScopedModels) {
        // Sequelize forwards unknown SyncOptions to every QueryInterface call; its v6 typings
        // omit `transaction`, although the runtime supports and propagates it.
        await model.schema(schemaName).sync(transactionalSyncOptions);
    }
    const completed = await runTenantMigrations(schemaName, repairHistoryKnown, sequelize, transaction);
    if (completed.length) {
        console.log(`[tenant-schema] ${schemaName}: migrazioni completate (${completed.join(', ')})`);
    }
    await recordTenantModelBaseline(schemaName, sequelize, transaction);
}

/** Provision a tenant in the caller's transaction, used during registration before it is returned. */
export async function provisionTenantSchema(tenantId: string, transaction: Transaction): Promise<string> {
    const schemaName = getTenantSchemaName(tenantId);
    const syncOptions = syncOptionsFor();
    if (syncOptions) await initializeTenantSchema(schemaName, syncOptions, transaction);
    return schemaName;
}

/** Mark a schema provisioned in a transaction that has just committed successfully. */
export function markTenantSchemaReady(tenantId: string): void {
    ensuredSchemas.add(getTenantSchemaName(tenantId));
}

/**
 * Upgrade every existing tenant before the HTTP listener starts. Work is bounded to avoid
 * exhausting the Sequelize pool; a single failure rejects startup and therefore the deploy.
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
 * Invalida la cache: il prossimo accesso al tenant rieseguirà `CREATE SCHEMA` + sync.
 * Utile dopo una migration applicata a caldo, senza dover riavviare il processo.
 */
export function invalidateTenantSchemaCache(tenantId?: string): void {
    if (tenantId) {
        ensuredSchemas.delete(getTenantSchemaName(tenantId));
        return;
    }
    ensuredSchemas.clear();
}



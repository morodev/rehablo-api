import { ModelStatic, SyncOptions } from 'sequelize';
import { sequelize } from '../config/database.js';
import { env } from '../config/env.js';

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
    await sequelize.createSchema(schemaName, {});

    const syncOptions = syncOptionsFor();

    if (syncOptions) {
        const failed: string[] = [];

        for (const model of tenantScopedModels) {
            try {
                await model.schema(schemaName).sync(syncOptions);
            } catch (err) {
                // Un modello che non si allinea NON deve rendere inutilizzabile l'intero tenant.
                // Prima, un errore su una qualsiasi delle ~30 tabelle usciva da
                // `resolveTenantSchema` come 500 su OGNI richiesta di quel tenant e, non essendo
                // mai raggiunta `ensuredSchemas.add()`, il sync completo veniva ritentato (e
                // rifallito) a ogni chiamata: outage totale invece che degrado localizzato.
                failed.push(model.name);
                console.error(`[tenant-schema] sync di "${model.name}" fallito su ${schemaName}`, err);
            }
        }

        if (failed.length > 0) {
            console.error(
                `[tenant-schema] ${schemaName}: modelli non allineati -> ${failed.join(', ')}. ` +
                    'Le tabelle esistenti restano utilizzabili; se manca una colonna nuova, allinearla con una migration.'
            );
        }
    }

    // Marcato come pronto anche in presenza di errori parziali: ritentare il sync a ogni
    // richiesta non ripara nulla e moltiplica il carico sul database.
    ensuredSchemas.add(schemaName);

    return schemaName;
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



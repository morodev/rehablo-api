import type {Sequelize, Transaction} from 'sequelize';
import {type DatabaseManifest, SchemaReadinessError, quoteTenantSchema} from './migrationTypes.js';

// Two fixed int32 keys shared by every release runner and provisioning transaction.
const RELEASE_LOCK_KEYS = [1380270671, 18700];

export async function initializeControlTables(database: Sequelize, transaction: Transaction): Promise<void> {
    for (const sql of [
        `CREATE TABLE IF NOT EXISTS public.schema_control (
            "singleton" BOOLEAN PRIMARY KEY DEFAULT true CHECK ("singleton"),
            "releaseId" VARCHAR(160) NOT NULL, "checksum" VARCHAR(128) NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS public.schema_releases (
            "id" VARCHAR(160) PRIMARY KEY, "checksum" VARCHAR(128) NOT NULL,
            "manifest" JSONB NOT NULL, "completedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
        `CREATE TABLE IF NOT EXISTS public.tenant_schema_state (
            "schemaName" VARCHAR(80) PRIMARY KEY, "releaseId" VARCHAR(160) NOT NULL,
            "checksum" VARCHAR(128) NOT NULL, "compatibleReleases" JSONB NOT NULL DEFAULT '[]'::jsonb,
            "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`
    ]) await database.query(sql, {transaction});
}

/** Session lock owns its physical connection until unlock; returning it to the pool would leak the lock. */
export async function withReleaseLock<T>(
    database: Sequelize, work: () => Promise<T>, mode: 'exclusive' | 'shared' = 'exclusive', waitTimeoutMs = 10_000
): Promise<T> {
    if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 1 || waitTimeoutMs > 300_000) {
        throw new Error('Release lock wait timeout must be between 1 and 300000 milliseconds');
    }
    const manager = database.connectionManager as any;
    const connection = await manager.getConnection({type: 'WRITE', useMaster: true});
    const suffix = mode === 'shared' ? '_shared' : '';
    let locked = false;
    let unsafeConnection = false;
    let previousTimeout: string | undefined;
    try {
        const settings = await connection.query('SHOW lock_timeout');
        previousTimeout = settings?.rows?.[0]?.lock_timeout ?? '0';
        await connection.query("SELECT set_config('lock_timeout', $1, false)", [String(waitTimeoutMs) + 'ms']);
        await connection.query(`SELECT pg_advisory_lock${suffix}($1, $2)`, RELEASE_LOCK_KEYS);
        locked = true;
        return await work();
    } finally {
        try {
            if (locked) await connection.query(`SELECT pg_advisory_unlock${suffix}($1, $2)`, RELEASE_LOCK_KEYS);
            if (previousTimeout !== undefined) await connection.query("SELECT set_config('lock_timeout', $1, false)", [previousTimeout]);
        } catch (error) {
            unsafeConnection = true;
            // An unlock failure must never put a potentially locked connection back in the pool.
            await manager.destroyConnection(connection);
            throw error;
        } finally {
            if (!unsafeConnection) await manager.releaseConnection(connection);
        }
    }
}

export async function lockProvisioning(database: Sequelize, transaction: Transaction): Promise<void> {
    await database.query("SET LOCAL lock_timeout = '10s'", {transaction});
    await database.query('SELECT pg_advisory_xact_lock_shared(:keyA, :keyB)', {
        transaction, replacements: {keyA: RELEASE_LOCK_KEYS[0], keyB: RELEASE_LOCK_KEYS[1]}
    });
}

export async function controlTablesExist(database: Sequelize, transaction?: Transaction): Promise<boolean> {
    const [rows] = await database.query(`SELECT to_regclass('public.schema_control') AS control,
        to_regclass('public.schema_releases') AS releases, to_regclass('public.tenant_schema_state') AS tenants`, {transaction});
    const row = (rows as any[])[0];
    return !!(row?.control && row?.releases && row?.tenants);
}

export async function assertDatabaseReady(manifest: DatabaseManifest, database: Sequelize): Promise<void> {
    if (!await controlTablesExist(database)) throw new SchemaReadinessError('Database migrations have not been initialized; run db:migrate before starting the API');
    const [rows] = await database.query(`SELECT r."checksum" FROM public.schema_releases r
        WHERE r."id" = :release AND EXISTS (SELECT 1 FROM public.schema_control WHERE "singleton" = true)`, {
        replacements: {release: manifest.id}
    });
    const row = (rows as any[])[0];
    if (!row) throw new SchemaReadinessError(`Database release ${manifest.id} is not complete; run db:migrate before starting the API`);
    if (row.checksum !== manifest.checksum) throw new SchemaReadinessError(`Database release ${manifest.id} checksum mismatch`);
}

export async function assertTenantReady(
    schema: string, manifest: DatabaseManifest, database: Sequelize, transaction?: Transaction
): Promise<void> {
    quoteTenantSchema(schema);
    const [rows] = await database.query(`SELECT t."releaseId", t."checksum", r."checksum" AS "releaseChecksum"
        FROM public.tenant_schema_state t
        LEFT JOIN public.schema_releases r ON r."id" = :release
        WHERE t."schemaName" = :schema AND t."compatibleReleases" ? :release`, {
        transaction, replacements: {schema, release: manifest.id}
    });
    const row = (rows as any[])[0];
    if (!row || row.releaseChecksum !== manifest.checksum ||
        (row.releaseId === manifest.id && row.checksum !== manifest.checksum)) {
        throw new SchemaReadinessError(`Tenant schema ${schema} is not ready for release ${manifest.id}`);
    }
}

/** Caller must acquire lockProvisioning before reading the target, and keep it until tenant commit. */
export async function assertProvisioningRelease(
    manifest: DatabaseManifest, database: Sequelize, transaction: Transaction
): Promise<void> {
    const [rows] = await database.query(`SELECT c."releaseId", c."checksum", r."checksum" AS "releaseChecksum"
        FROM public.schema_control c JOIN public.schema_releases r ON r."id" = c."releaseId"
        WHERE c."singleton" = true`, {transaction});
    const row = (rows as any[])[0];
    if (!row || row.releaseId !== manifest.id || row.checksum !== manifest.checksum || row.releaseChecksum !== manifest.checksum) {
        throw new SchemaReadinessError('Tenant registration is waiting for an API version compatible with the current database release');
    }
}

export async function recordTenantReady(
    schema: string, manifest: DatabaseManifest, database: Sequelize, transaction: Transaction
): Promise<void> {
    quoteTenantSchema(schema);
    await database.query(`INSERT INTO public.tenant_schema_state
        ("schemaName", "releaseId", "checksum", "compatibleReleases", "updatedAt")
        VALUES (:schema, :release, :checksum,
            COALESCE((SELECT jsonb_agg("id") FROM public.schema_releases), '[]'::jsonb) || jsonb_build_array(CAST(:release AS text)), NOW())
        ON CONFLICT ("schemaName") DO UPDATE SET "releaseId" = EXCLUDED."releaseId", "checksum" = EXCLUDED."checksum",
            "compatibleReleases" = EXCLUDED."compatibleReleases", "updatedAt" = NOW()`, {
        transaction, replacements: {schema, release: manifest.id, checksum: manifest.checksum}
    });
}

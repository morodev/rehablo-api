import {Umzug, type UmzugStorage} from 'umzug';
import type {Sequelize, Transaction} from 'sequelize';
import {sequelize} from '../config/database.js';
import {type DatabaseManifest, type MigrationStep, manifestRecord, quoteTenantSchema, validateManifest} from './migrationTypes.js';
import {controlTablesExist, initializeControlTables, recordTenantReady, withReleaseLock} from './releaseControl.js';

export interface MigrationRunOptions {
    database?: Sequelize;
    concurrency?: number;
    lockTimeoutMs?: number;
    /** Global release coordination can wait while the preceding API finishes bootstrap/provisioning. */
    releaseLockTimeoutMs?: number;
    statementTimeoutMs?: number;
    timeoutMs?: number;
    /** Startup also adopts tenants created by the old API after a successful pre-deploy. */
    reconcileMissingTenants?: boolean;
    onProgress?(event: {event: string; schema?: string; migration?: string; durationMs?: number; completedTenants?: number; totalTenants?: number}): void;
    preparePublic?(database: Sequelize, transaction: Transaction): Promise<void>;
    prepareTenant?(schema: string, database: Sequelize, transaction: Transaction): Promise<void>;
}

export interface DatabaseStatus {
    ready: boolean;
    currentRelease: string | null;
    release: string;
    tenants?: Array<{schemaName: string; releaseId: string}>;
}

/** Read-only: status never initializes metadata, takes locks or attempts a model synchronization. */
export async function getDatabaseStatus(
    manifest: DatabaseManifest, database: Sequelize = sequelize, includeTenants = false
): Promise<DatabaseStatus> {
    validateManifest(manifest);
    if (!await controlTablesExist(database)) return {ready: false, currentRelease: null, release: manifest.id, ...(includeTenants ? {tenants: []} : {})};
    const [rows] = await database.query(`SELECT c."releaseId", r."checksum"
        FROM public.schema_control c LEFT JOIN public.schema_releases r ON r."id" = :release
        WHERE c."singleton" = true`, {replacements: {release: manifest.id}});
    const row = (rows as any[])[0];
    if (row?.checksum && row.checksum !== manifest.checksum) throw new Error(`Database release ${manifest.id} checksum mismatch`);
    const status: DatabaseStatus = {ready: !!row?.checksum, currentRelease: row?.releaseId ?? null, release: manifest.id};
    if (includeTenants) {
        const [tenants] = await database.query('SELECT "schemaName", "releaseId" FROM public.tenant_schema_state ORDER BY "schemaName"');
        status.tenants = tenants as DatabaseStatus['tenants'];
    }
    return status;
}

function assertAppendOnly(previous: any, manifest: DatabaseManifest): void {
    for (const scope of ['publicMigrations', 'tenantMigrations'] as const) {
        for (const [index, step] of (previous?.[scope] ?? []).entries()) {
            const current = manifest[scope][index];
            if (current?.name !== step.name || current.checksum !== step.checksum) {
                throw new Error(`Database release must preserve immutable migration order and content for ${step.name}; append a new migration instead`);
            }
        }
    }
}

/** The complete execution ledger and each version insertion use the caller's tenant transaction. */
async function runSteps(
    steps: MigrationStep[], scope: 'public' | 'tenant', schema: string, database: Sequelize, transaction: Transaction,
    assertWithinDeadline: () => void = () => {}, onProgress?: MigrationRunOptions['onProgress']
): Promise<number> {
    const prefix = scope === 'public' ? 'public' : quoteTenantSchema(schema);
    const table = scope === 'public' ? 'platform_schema_migrations' : 'schema_migrations';
    const registry = `${prefix}."${table}"`;
    await database.query(`CREATE TABLE IF NOT EXISTS ${registry} (
        "version" VARCHAR(160) PRIMARY KEY, "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "checksum" VARCHAR(128))`, {transaction});
    // Existing tenant ledgers retain every version and timestamp; pre-transition rows have unknown checksums.
    await database.query(`ALTER TABLE ${registry} ADD COLUMN IF NOT EXISTS "checksum" VARCHAR(128)`, {transaction});
    const [rows] = await database.query(`SELECT "version", "checksum" FROM ${registry}`, {transaction});
    const checksums = new Map((rows as Array<{version: string; checksum: string | null}>).map(row => [row.version, row.checksum]));
    for (const step of steps) {
        const previous = checksums.get(step.name);
        if (previous && previous !== step.checksum) throw new Error(`Migration ${step.name} checksum mismatch in ${schema}`);
    }
    const storage: UmzugStorage = {
        executed: async () => [...checksums.keys()],
        logMigration: async ({name}) => {
            const step = steps.find(candidate => candidate.name === name)!;
            await database.query(`INSERT INTO ${registry} ("version", "checksum") VALUES (:version, :checksum)`, {
                transaction, replacements: {version: name, checksum: step.checksum}
            });
            checksums.set(name, step.checksum);
        },
        unlogMigration: async () => {throw new Error('Automatic database migration rollback is disabled');}
    };
    const runner = new Umzug({
        context: {database, schema, transaction}, storage, logger: undefined,
        migrations: steps.map(step => ({name: step.name, up: async () => {
            assertWithinDeadline();
            const started = Date.now();
            onProgress?.({event: 'migration-started', schema, migration: step.name});
            await step.up(database, schema, transaction);
            onProgress?.({event: 'migration-applied', schema, migration: step.name, durationMs: Date.now() - started});
        }}))
    });
    return (await runner.up()).length;
}

export async function runTenantMigrations(
    manifest: DatabaseManifest, schema: string, database: Sequelize, transaction: Transaction
): Promise<number> {
    quoteTenantSchema(schema);
    await database.query("SET LOCAL lock_timeout = '10s'", {transaction});
    await database.query('SELECT pg_advisory_xact_lock(hashtext(:schema), hashtext(:operation))', {
        transaction, replacements: {schema, operation: 'tenant-schema-migrations'}
    });
    await database.query(`CREATE SCHEMA IF NOT EXISTS ${quoteTenantSchema(schema)}`, {transaction});
    return runSteps(manifest.tenantMigrations, 'tenant', schema, database, transaction);
}

export async function migrateDatabase(
    manifest: DatabaseManifest, options: MigrationRunOptions = {}
): Promise<{release: string; noop: boolean; tenants: number; migrations: number}> {
    validateManifest(manifest);
    const database = options.database ?? sequelize;
    const concurrency = options.concurrency ?? 2;
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Migration concurrency must be a positive integer');
    const poolCapacity = (database as unknown as {options?: {pool?: {max?: number}}}).options?.pool?.max ?? 5;
    if (concurrency > poolCapacity - 1) {
        throw new Error(`Migration concurrency must leave one connection for the release lock (pool max ${poolCapacity})`);
    }
    const lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    const releaseLockTimeoutMs = options.releaseLockTimeoutMs ?? options.lockTimeoutMs ?? 300_000;
    const statementTimeoutMs = options.statementTimeoutMs ?? 120_000;
    const timeoutMs = options.timeoutMs ?? 25 * 60_000;
    if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs < 1 || statementTimeoutMs > 120_000) {
        throw new Error('Migration statement timeout must be between 1 and 120000 milliseconds');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 25 * 60_000) {
        throw new Error('Database release deadline must be between 1 and 1500000 milliseconds');
    }
    const deadline = Date.now() + timeoutMs;
    const assertWithinDeadline = () => {
        if (Date.now() >= deadline) throw new Error('Database release deadline exceeded; retry to resume completed migration checkpoints');
    };
    const transaction = async <T>(work: (transaction: Transaction) => Promise<T>): Promise<T> => {
        assertWithinDeadline();
        return database.transaction(async current => {
            await database.query("SELECT set_config('lock_timeout', :lockTimeout, true), set_config('statement_timeout', :statementTimeout, true)", {
                transaction: current, replacements: {lockTimeout: String(lockTimeoutMs) + 'ms', statementTimeout: String(statementTimeoutMs) + 'ms'}
            });
            const remaining = Math.max(1, deadline - Date.now());
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const expired = new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error('Database release deadline exceeded; active migration transaction is being rolled back')), remaining);
                });
                // A timeout rejects this callback and Sequelize rolls back its transaction. Any
                // active SQL is bounded by statement_timeout; rollback finishes before lock release.
                return await Promise.race([work(current), expired]);
            } finally {
                if (timer) clearTimeout(timer);
            }
        });
    };
    const lockStarted = Date.now();
    options.onProgress?.({event: 'release-lock-acquiring'});
    return withReleaseLock(database, async () => {
        options.onProgress?.({event: 'release-lock-acquired', durationMs: Date.now() - lockStarted});
        assertWithinDeadline();
        const before = await getDatabaseStatus(manifest, database);
        // A later, incomplete release may already have upgraded some tenant checkpoints.
        // An older ready API may adopt an unregistered tenant, but must not rewrite those checkpoints.
        const pendingCondition = before.ready ? 's."schemaName" IS NULL'
            : 's."releaseId" IS DISTINCT FROM :release OR s."checksum" IS DISTINCT FROM :checksum';
        if (before.ready) {
            // A compatible older API must never provision or downgrade a newer database release.
            if (!options.reconcileMissingTenants || before.currentRelease !== manifest.id) {
                return {release: manifest.id, noop: true, tenants: 0, migrations: 0};
            }
            const [missing] = await database.query(`SELECT t."id" FROM public.tenants t
                LEFT JOIN public.tenant_schema_state s ON s."schemaName" = 'rehablo_' || replace(t."id"::text, '-', '')
                WHERE ${pendingCondition} LIMIT 1`, {
                replacements: {release: manifest.id, checksum: manifest.checksum}
            });
            if (!(missing as any[]).length) return {release: manifest.id, noop: true, tenants: 0, migrations: 0};
        }
        if (!before.ready) await transaction(async current => {
            options.onProgress?.({event: 'release-metadata-started'});
            await initializeControlTables(database, current);
            const [rows] = await database.query(`SELECT r."manifest" FROM public.schema_control c
                JOIN public.schema_releases r ON r."id" = c."releaseId" WHERE c."singleton" = true`, {transaction: current});
            const row = (rows as any[])[0];
            if (row) assertAppendOnly(row.manifest, manifest);
        });
        if (!before.ready) options.onProgress?.({event: 'release-metadata-ready'});
        if (!before.ready && options.preparePublic) await transaction(current => options.preparePublic!(database, current));
        // PostgreSQL requires a committed ALTER TYPE ADD VALUE before a later step can use
        // the new enum label. Every public step and its version row commit together.
        let migrations = 0;
        for (const step of before.ready ? [] : manifest.publicMigrations) migrations += await transaction(current =>
            runSteps([step], 'public', 'public', database, current, assertWithinDeadline, options.onProgress));
        assertWithinDeadline();
        const [pending] = await database.query(`SELECT t."id" FROM public.tenants t
            LEFT JOIN public.tenant_schema_state s ON s."schemaName" = 'rehablo_' || replace(t."id"::text, '-', '')
            WHERE ${pendingCondition}
            ORDER BY t."id"`, {replacements: {release: manifest.id, checksum: manifest.checksum}});
        const tenants = pending as Array<{id: string}>;
        let cursor = 0;
        let completedTenants = 0;
        let failed: unknown;
        const worker = async () => {
            while (cursor < tenants.length && !failed) {
                const {id} = tenants[cursor++];
                const schema = 'rehablo_' + id.replaceAll('-', '');
                try {
                    const completed = await transaction(async current => {
                        await database.query('SELECT pg_advisory_xact_lock(hashtext(:schema), hashtext(:operation))', {
                            transaction: current, replacements: {schema, operation: 'tenant-schema-migrations'}
                        });
                        await database.query(`CREATE SCHEMA IF NOT EXISTS ${quoteTenantSchema(schema)}`, {transaction: current});
                        await options.prepareTenant?.(schema, database, current);
                        const count = await runSteps(manifest.tenantMigrations, 'tenant', schema, database, current, assertWithinDeadline, options.onProgress);
                        await recordTenantReady(schema, manifest, database, current);
                        return count;
                    });
                    migrations += completed;
                    options.onProgress?.({event: 'tenant-committed', schema, completedTenants: ++completedTenants, totalTenants: tenants.length});
                } catch (error) {
                    failed = new Error(`Tenant migration failed for ${schema}: ${error instanceof Error ? error.message : String(error)}`, {cause: error});
                }
            }
        };
        await Promise.all(Array.from({length: Math.min(concurrency, tenants.length)}, worker));
        if (failed) throw failed;
        await transaction(async current => {
            const [rows] = await database.query(`SELECT t."id" FROM public.tenants t
                LEFT JOIN public.tenant_schema_state s ON s."schemaName" = 'rehablo_' || replace(t."id"::text, '-', '')
                WHERE ${pendingCondition} LIMIT 1`, {
                transaction: current, replacements: {release: manifest.id, checksum: manifest.checksum}
            });
            if ((rows as any[]).length) throw new Error('Database release has tenants that are not ready');
            // Reconciliation updates only missing tenant checkpoints, not the published release.
            if (before.ready) return;
            await database.query(`INSERT INTO public.schema_releases ("id", "checksum", "manifest")
                VALUES (:release, :checksum, CAST(:manifest AS jsonb))`, {
                transaction: current, replacements: {release: manifest.id, checksum: manifest.checksum, manifest: JSON.stringify(manifestRecord(manifest))}
            });
            await database.query(`INSERT INTO public.schema_control ("singleton", "releaseId", "checksum")
                VALUES (true, :release, :checksum) ON CONFLICT ("singleton") DO UPDATE
                SET "releaseId" = EXCLUDED."releaseId", "checksum" = EXCLUDED."checksum"`, {
                transaction: current, replacements: {release: manifest.id, checksum: manifest.checksum}
            });
        });
        return {release: manifest.id, noop: false, tenants: tenants.length, migrations};
    }, 'exclusive', Math.min(releaseLockTimeoutMs, timeoutMs),
        durationMs => options.onProgress?.({event: 'release-lock-waiting', durationMs}));
}

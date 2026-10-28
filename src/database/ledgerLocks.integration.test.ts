import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {Sequelize, type Transaction} from 'sequelize';
import {requireMigrationsTestDatabase} from '../../scripts/test-database-migrations-integration.mjs';

test('CLI adoption preserves historical registries while readers remain connected and rejects real lock conflicts', {timeout: 180000}, async t => {
    const target = requireMigrationsTestDatabase(process.env);
    Object.assign(process.env, {DATABASE_URL: target.databaseUrl, NODE_ENV: 'production', DB_SSL: 'false',
        JWT_SECRET: randomBytes(32).toString('hex'), DEVICE_CREDENTIALS_SECRET: randomBytes(32).toString('hex')});
    const {provisionTenantSchema, requiredMigrationNames} = await import('./standardMigrations.js');
    const {databaseManifest} = await import('./migrationManifest.js');
    const {schemaBaseline} = await import('./schemaBaseline.js');
    const {sequelize: modelDatabase} = await import('../config/database.js');
    const database = new Sequelize(target.databaseUrl, {dialect: 'postgres', logging: false,
        dialectOptions: {ssl: false}, pool: {max: 2, min: 0}});
    const readerDatabase = new Sequelize(target.databaseUrl, {dialect: 'postgres', logging: false,
        dialectOptions: {ssl: false}, pool: {max: 1, min: 0}});
    const directory = fileURLToPath(new URL('../..', import.meta.url));
    const require = createRequire(import.meta.url);
    const script: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts['db:migrate'];
    const command = script.match(/"[^"]*"|'[^']*'|[^\s]+/g)!.map(argument => argument.replace(/^(['"])(.*)\1$/, '$2'));
    assert.ok(['sequelize', 'sequelize-cli'].includes(command.shift()!), 'Exercise the official deployment CLI');
    const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    const schemas = new Set<string>();
    const reminderVersion = '20261028-appointment-reminders-v1';
    const baselineVersion = '20261028-tenant-schema-baseline-v1';
    const knownTables = new Set([...schemaBaseline.public.map(table => table.name),
        'SequelizeMeta', 'platform_schema_migrations', 'auth_schema_migrations', 'auth_security_migrations',
        'activity_notification_migrations', 'activity_notification_preferences', 'account_action_tokens']);
    const knownEnums = new Set(schemaBaseline.public.flatMap(table => table.enums.flatMap(sql =>
        [...sql.matchAll(/CREATE TYPE "public"\."([^"]+)"/g)].map(match => match[1]))));
    let ownsFixture = false;
    const runCli = async () => {
        const child = spawn(process.execPath, [require.resolve('sequelize-cli/lib/sequelize'), ...command],
            {cwd: directory, env: {...process.env}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
        let output = '';
        child.stdout.on('data', chunk => {output += String(chunk);});
        child.stderr.on('data', chunk => {output += String(chunk);});
        const timer = setTimeout(() => child.kill(), 45000);
        try {
            const code = await new Promise<number | null>((resolve, reject) => {
                child.once('error', reject); child.once('close', resolve);
            });
            return {code, output};
        } finally {clearTimeout(timer);}
    };
    const ledger = (schema: string) => schema === 'public' ? 'public.platform_schema_migrations' : quote(schema) + '.schema_migrations';
    const ledgerSnapshot = async (schema: string) => {
        const table = ledger(schema);
        const [columns] = await database.query(`SELECT c.oid,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type
            FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
            WHERE c.oid=to_regclass(:table) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, {replacements: {table}});
        const hasChecksum = (columns as Array<{name: string}>).some(column => column.name === 'checksum');
        const [rows] = await database.query(`SELECT version,"appliedAt"${hasChecksum ? ',checksum' : ''} FROM ${table} ORDER BY version`);
        return {columns, rows: rows as Array<{version: string; appliedAt: Date; checksum?: string | null}>};
    };
    const prepareAdoption = async () => {
        const id = randomUUID(), schema = 'rehablo_' + id.replaceAll('-', '');
        schemas.add(schema);
        await database.query(`INSERT INTO public.tenants(id,license,"idStripe","maxUserQuantity","maxStructureQuantity","createdAt","updatedAt")
            VALUES (:id,'synthetic-lock-test','synthetic',1,1,NOW(),NOW())`, {replacements: {id}});
        await database.transaction(transaction => provisionTenantSchema(database, schema, transaction));
        await database.query(`DELETE FROM ${ledger(schema)} WHERE version=:version`, {replacements: {version: reminderVersion}});
        await database.query(`DELETE FROM ${quote(schema)}."SequelizeMeta"`);
        await database.query('DELETE FROM public."SequelizeMeta"');
        return schema;
    };
    const assertPending = async (schema: string) => {
        const [global] = await database.query('SELECT name FROM public."SequelizeMeta"');
        const [tenant] = await database.query(`SELECT name FROM ${quote(schema)}."SequelizeMeta"`);
        assert.deepEqual(global, [], 'A blocked migration cannot record global success');
        assert.deepEqual(tenant, [], 'A blocked tenant migration cannot record tenant success');
    };
    const withReader = async (work: (transaction: Transaction, pid: number) => Promise<void>) => {
        const transaction = await readerDatabase.transaction();
        try {
            const [rows] = await readerDatabase.query('SELECT pg_backend_pid() AS pid', {transaction});
            await work(transaction, (rows[0] as {pid: number}).pid);
            await readerDatabase.query('SELECT 1', {transaction});
        } finally {await transaction.rollback();}
    };
    try {
        await database.authenticate();
        const [identity] = await database.query('SELECT current_database() AS name');
        assert.equal((identity[0] as {name: string}).name, target.databaseName);
        const [existing] = await database.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
        const [existingEnums] = await database.query(`SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
            WHERE n.nspname='public' AND t.typtype='e'`);
        assert.equal(existing.length, 0, 'Lock tests require an empty disposable database');
        assert.equal(existingEnums.length, 0, 'Lock tests require no pre-existing public enums');
        ownsFixture = true;
        const initial = await runCli();
        assert.equal(initial.code, 0, initial.output);

        for (const hasChecksum of [false, true]) {
            await t.test(`readers of ${hasChecksum ? 'checksum-bearing public and tenant' : 'original two-column tenant'} history do not block adoption`, async () => {
                const schema = await prepareAdoption();
                for (const current of ['public', schema]) {
                    if (hasChecksum) {
                        await database.query(`ALTER TABLE ${ledger(current)} ADD COLUMN IF NOT EXISTS checksum VARCHAR(128)`);
                        const steps = current === 'public' ? databaseManifest.publicMigrations : databaseManifest.tenantMigrations;
                        for (const step of steps) await database.query(`UPDATE ${ledger(current)} SET checksum=:checksum WHERE version=:version`,
                            {replacements: {checksum: step.checksum, version: step.name}});
                    } else await database.query(`ALTER TABLE ${ledger(current)} DROP COLUMN checksum`);
                }
                const beforePublic = await ledgerSnapshot('public'), beforeTenant = await ledgerSnapshot(schema);
                await withReader(async (transaction, pid) => {
                    // The original two-column case reproduces the reported tenant pre-step timeout.
                    // The checksum case also protects the public adoption path against redundant DDL.
                    const readSchemas = hasChecksum ? ['public', schema] : [schema];
                    for (const current of readSchemas) await readerDatabase.query(`SELECT version FROM ${ledger(current)}`, {transaction});
                    const result = await runCli();
                    assert.equal(result.code, 0, 'Adoption must finish before the reader transaction ends: ' + result.output);
                    const [locks] = await database.query(`SELECT relation::regclass::text AS relation FROM pg_locks
                        WHERE pid=:pid AND mode='AccessShareLock' AND granted
                          AND relation IN (to_regclass(:publicLedger),to_regclass(:tenantLedger))`,
                        {replacements: {pid, publicLedger: ledger('public'), tenantLedger: ledger(schema)}});
                    assert.equal(locks.length, readSchemas.length, 'Original reader locks must remain held after successful migration');
                    assert.deepEqual(await ledgerSnapshot('public'), beforePublic, 'Public ledger shape, OID, checksums and timestamps stay unchanged');
                    const afterTenant = await ledgerSnapshot(schema);
                    assert.deepEqual(afterTenant.columns, beforeTenant.columns, 'Adoption must not add checksum or rewrite the existing ledger');
                    assert.deepEqual(afterTenant.rows.filter(row => row.version !== reminderVersion), beforeTenant.rows);
                    const added = afterTenant.rows.filter(row => row.version === reminderVersion);
                    assert.equal(added.length, 1, 'The real pending reminder migration must record its receipt');
                    if (hasChecksum) assert.equal(added[0].checksum, databaseManifest.tenantMigrations.find(step => step.name === reminderVersion)!.checksum);
                    const [global] = await database.query('SELECT name FROM public."SequelizeMeta" ORDER BY name');
                    const [tenant] = await database.query(`SELECT name FROM ${quote(schema)}."SequelizeMeta" ORDER BY name`);
                    for (const rows of [global, tenant]) assert.deepEqual((rows as Array<{name: string}>).map(row => row.name), requiredMigrationNames);
                });
            });
        }

        await t.test('a real same-tenant advisory conflict still fails and cannot record success', async () => {
            const schema = await prepareAdoption();
            await withReader(async transaction => {
                await readerDatabase.query('SELECT pg_advisory_xact_lock(hashtext(:schema),hashtext(:operation))',
                    {transaction, replacements: {schema, operation: 'tenant-schema-migrations'}});
                const result = await runCli();
                assert.equal(result.code, 1, result.output);
                assert.match(result.output, /55P03/);
                assert.match(result.output, /advisory lock/i);
                await assertPending(schema);
            });
        });

        await t.test('a reader blocking required business-table DDL still fails with SQL context and no receipt', async () => {
            const schema = await prepareAdoption();
            await database.query(`ALTER TABLE ${quote(schema)}.patients DROP COLUMN color`);
            await database.query(`DELETE FROM ${ledger(schema)} WHERE version=:version`, {replacements: {version: baselineVersion}});
            await withReader(async transaction => {
                await readerDatabase.query(`SELECT id FROM ${quote(schema)}.patients`, {transaction});
                const result = await runCli();
                assert.equal(result.code, 1, result.output);
                assert.match(result.output, /55P03/);
                assert.match(result.output, /ALTER TABLE[^\r\n]*patients/i);
                await assertPending(schema);
                const [rows] = await database.query(`SELECT version FROM ${ledger(schema)} WHERE version IN (:versions)`,
                    {replacements: {versions: [baselineVersion, reminderVersion]}});
                assert.deepEqual(rows, [], 'Failed DDL must not record the baseline or pending reminder receipt');
            });
        });
    } finally {
        try {
            if (ownsFixture) {
                for (const schema of schemas) await database.query('DROP SCHEMA IF EXISTS ' + quote(schema) + ' CASCADE');
                const [tables] = await database.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
                for (const row of tables as Array<{tablename: string}>) {
                    assert.ok(knownTables.has(row.tablename), 'Refusing cleanup of an unowned table: ' + row.tablename);
                    await database.query('DROP TABLE public.' + quote(row.tablename) + ' CASCADE');
                }
                const [types] = await database.query(`SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e'`);
                for (const row of types as Array<{typname: string}>) {
                    assert.ok(knownEnums.has(row.typname), 'Refusing cleanup of an unowned enum: ' + row.typname);
                    await database.query('DROP TYPE public.' + quote(row.typname));
                }
            }
        } finally {
            await readerDatabase.close();
            await database.close();
            await modelDatabase.close();
        }
    }
});

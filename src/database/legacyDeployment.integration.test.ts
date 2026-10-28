import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {get} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {test} from 'node:test';
import type {Sequelize} from 'sequelize';
import {requireMigrationsTestDatabase} from '../../scripts/test-database-migrations-integration.mjs';

test('legacy deployments upgrade directly and preserve existing business data', {timeout: 180000}, async t => {
    const target = requireMigrationsTestDatabase(process.env);
    Object.assign(process.env, {DATABASE_URL: target.databaseUrl, NODE_ENV: 'production', DB_SSL: 'false',
        DATABASE_MIGRATION_PHASE: 'bridge', TENANT_SCHEMA_SYNC: 'additive',
        JWT_SECRET: randomBytes(32).toString('hex'), DEVICE_CREDENTIALS_SECRET: randomBytes(32).toString('hex'),
        BACKGROUND_JOBS_ENABLED: 'false', ACTIVITIES_DELIVERY_ENABLED: 'false', REMINDER_EXTERNAL_DELIVERY_ENABLED: 'false'});
    const directory = fileURLToPath(new URL('../..', import.meta.url));
    const cli = fileURLToPath(new URL('../../dist/scripts/databaseMigrations.js', import.meta.url));
    assert.ok(existsSync(cli), 'Build the deployment artifact before running legacy deployment tests');
    const {sequelize: database} = await import('../config/database.js');
    const {registerDatabaseModels} = await import('./registerModels.js');
    const {getTenantScopedModels} = await import('../utils/tenantSchema.js');
    const {tenantMigrations, prepareTenantPaymentHistory, runTenantMigrations} = await import('../utils/tenantMigrations.js');
    const {databaseManifest} = await import('./migrationManifest.js');
    const {schemaBaseline} = await import('./schemaBaseline.js');
    registerDatabaseModels();
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'rehablo-legacy-deployment-'));
    const noSyncGuard = join(temporaryDirectory, 'forbid-runtime-sync.mjs');
    writeFileSync(noSyncGuard, `import {createRequire} from 'node:module';
const require = createRequire(${JSON.stringify(join(directory, 'package.json'))});
const {Model, Sequelize} = require('sequelize');
const forbidden = () => {throw new Error('Runtime model sync is forbidden in release regression tests');};
Model.sync = forbidden;
Sequelize.prototype.sync = forbidden;
`);
    const tenantId = randomUUID(), patientId = randomUUID(), structureId = randomUUID();
    const eventId = randomUUID(), evaluationId = randomUUID(), accountId = randomUUID();
    const schema = 'rehablo_' + tenantId.replaceAll('-', '');
    const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    const schemas = new Set([schema]);
    const knownTables = new Set([...schemaBaseline.public.map(table => table.name),
        'schema_control','schema_releases','tenant_schema_state','platform_schema_migrations','schema_transition',
        'auth_schema_migrations','auth_security_migrations','activity_notification_migrations','activity_notification_preferences','account_action_tokens']);
    const knownEnums = new Set(schemaBaseline.public.flatMap(table => table.enums.flatMap(sql =>
        [...sql.matchAll(/CREATE TYPE "public"\."([^"]+)"/g)].map(match => match[1]))));
    let ownsFixture = false;

    const spawnArtifact = (script: string, args: string[] = []) => {
        const child = spawn(process.execPath, ['--import', pathToFileURL(noSyncGuard).href, script, ...args], {cwd: directory,
            env: {...process.env, PORT: '0'}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
        let output = '';
        child.stdout!.on('data', chunk => {output += String(chunk);});
        child.stderr!.on('data', chunk => {output += String(chunk);});
        return {child, output: () => output};
    };
    const stop = async (child: ChildProcess) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
        child.kill();
        await closed;
    };
    const runCli = async () => {
        const {child, output} = spawnArtifact(cli, ['migrate']);
        const timer = setTimeout(() => child.kill(), 60000);
        try {
            const code = await new Promise<number | null>((resolve, reject) => {
                child.once('error', reject);
                child.once('close', resolve);
            });
            assert.equal(code, 0, 'Release migration failed: ' + output());
            return output();
        } finally {clearTimeout(timer); await stop(child);}
    };
    const health = (port: number): Promise<number> => new Promise((resolve, reject) => {
        const request = get(`http://127.0.0.1:${port}/health`, response => {response.resume(); resolve(response.statusCode ?? 0);});
        request.once('error', reject);
        request.setTimeout(1000, () => request.destroy(new Error('Health request timed out')));
    });
    const runServer = async () => {
        const {child, output} = spawnArtifact(fileURLToPath(new URL('../../dist/server.js', import.meta.url)));
        let ready = false;
        try {
            const deadline = Date.now() + 60000;
            while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
                const port = output().match(/listening on 0\.0\.0\.0:(\d+)/)?.[1];
                if (port) {
                    try {if (await health(Number(port)) === 200) {ready = true; break;}} catch { /* Startup is still in progress. */ }
                }
                await delay(50);
            }
            assert.equal(ready, true, 'Application failed to become ready: ' + output());
            assert.doesNotMatch(output(), /sync modello|public auth models|Runtime model sync is forbidden/);
            return output();
        } finally {await stop(child);}
    };
    const snapshotBusinessData = async (connection: Sequelize = database) => {
        const [patients] = await connection.query(`SELECT id,name,surname,emails,"phoneNumbers" FROM ${quote(schema)}.patients WHERE id=:id`, {replacements: {id: patientId}});
        const [events] = await connection.query(`SELECT id,"appointmentPaymentStatus","appointmentPaidAmount","appointmentExpectedAmount","appointmentPaymentHistoryKnown"
            FROM ${quote(schema)}.agenda_events WHERE id=:id`, {replacements: {id: eventId}});
        const [evaluations] = await connection.query(`SELECT id,"publishedToPatient" FROM ${quote(schema)}.evaluations WHERE id=:id`, {replacements: {id: evaluationId}});
        const [accounts] = await connection.query(`SELECT id,name,"openingBalance" FROM ${quote(schema)}.financial_accounts WHERE id=:id`, {replacements: {id: accountId}});
        const [versions] = await connection.query(`SELECT version,"appliedAt" FROM ${quote(schema)}.schema_migrations
            WHERE version IN (:versions) ORDER BY version`, {replacements: {versions: [...tenantMigrations.map(step => step.version), '20261026-tenant-model-baseline-v21']}});
        return {patients, events, evaluations, accounts, versions};
    };
    const insertTenant = (id: string) => database.query(`INSERT INTO public.tenants
        (id,license,"idStripe","maxUserQuantity","maxStructureQuantity","createdAt","updatedAt")
        VALUES (:id,'synthetic-legacy-release','synthetic',1,1,NOW(),NOW())`, {replacements: {id}});
    try {
        await database.authenticate();
        const [names] = await database.query('SELECT current_database() AS name');
        assert.equal((names[0] as any).name, target.databaseName);
        const [tables] = await database.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
        const [types] = await database.query(`SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e'`);
        assert.equal(tables.length, 0, 'Legacy deployment tests require an empty dedicated database');
        assert.equal(types.length, 0, 'Legacy deployment tests require no pre-existing enum types');
        ownsFixture = true;

        // Reproduce the former bootstrap in fixture setup only. Runtime child processes forbid all sync calls.
        const {syncAuthModels} = await import('../modules/auth/models/index.js');
        const {syncBillingModels} = await import('../modules/billing/models/billing.model.js');
        const {syncInvoicePublicModels} = await import('../modules/invoice/models/invoiceShareLink.model.js');
        const {syncQuotePublicModels} = await import('../modules/administration/models/quoteDelivery.model.js');
        const {syncCatalogModels} = await import('../modules/human-body/models/catalog/index.js');
        const {syncProtocolCatalogModels} = await import('../modules/protocols/models/catalog/index.js');
        const {syncMeasurementCatalogModels} = await import('../modules/measurements/models/catalog/index.js');
        for (const setup of [syncAuthModels,syncBillingModels,syncInvoicePublicModels,syncQuotePublicModels,
            syncCatalogModels,syncProtocolCatalogModels,syncMeasurementCatalogModels]) await setup();
        await insertTenant(tenantId);
        await database.query(`INSERT INTO public.structures(id,"tenantId",name,"createdAt","updatedAt")
            VALUES (:id,:tenant,'Synthetic legacy structure',NOW(),NOW())`, {replacements: {id: structureId, tenant: tenantId}});
        await database.transaction(async transaction => {
            await database.query(`CREATE SCHEMA ${quote(schema)}`, {transaction});
            const repair = await prepareTenantPaymentHistory(schema, database, transaction);
            for (const model of getTenantScopedModels()) {
                if (model.tableName === 'appointment_reminder_deliveries') continue;
                await model.schema(schema).sync({alter: {drop: false}, transaction} as any);
            }
            await runTenantMigrations(schema, repair, database, transaction);
            await database.query(`INSERT INTO ${quote(schema)}.schema_migrations(version,"appliedAt")
                VALUES ('20261026-tenant-model-baseline-v21','2026-10-26T00:00:00Z')`, {transaction});
        });
        const [controls] = await database.query("SELECT to_regclass('public.schema_transition') AS transition,to_regclass('public.schema_control') AS control");
        assert.deepEqual(controls[0], {transition: null, control: null}, 'Legacy fixture must not contain bridge or managed metadata');
        await database.query(`INSERT INTO ${quote(schema)}.patients
            (id,"tenantId","userId","structureId",name,surname,emails,"phoneNumbers","createdAt","updatedAt")
            VALUES (:id,:tenant,:user,:structure,'Synthetic patient','Preserved',ARRAY['{"email":"fixture@example.invalid"}'::jsonb],
                ARRAY['{"number":"0000000000","label":"mobile"}'::jsonb],NOW(),NOW())`,
            {replacements: {id: patientId, tenant: tenantId, user: randomUUID(), structure: structureId}});
        await database.query(`INSERT INTO ${quote(schema)}.agenda_events
            (id,"patientId","structureId",status,"appointmentPaymentStatus","appointmentPaidAmount","appointmentExpectedAmount","appointmentPaymentHistoryKnown","createdAt","updatedAt")
            VALUES (:id,:patient,:structure,'CONFIRMED','partial',35.25,80.50,false,NOW(),NOW())`,
            {replacements: {id: eventId, patient: patientId, structure: structureId}});
        await database.query(`INSERT INTO ${quote(schema)}.evaluations(id,"patientId","userId",date,status,"publishedToPatient","createdAt","updatedAt")
            VALUES (:id,:patient,:user,NOW(),'COMPLETED',false,NOW(),NOW())`, {replacements: {id: evaluationId, patient: patientId, user: randomUUID()}});
        await database.query(`INSERT INTO ${quote(schema)}.financial_accounts(id,"structureId",name,"openingBalance","createdAt","updatedAt")
            VALUES (:id,:structure,'Preserve historical account',123.45,NOW(),NOW())`, {replacements: {id: accountId, structure: structureId}});
        const before = await snapshotBusinessData();

        await t.test('existing tenants migrate directly despite stale bridge env and keep historical state', async () => {
            const output = await runCli();
            assert.match(output, /"noop":false/);
            assert.doesNotMatch(output, /Deploy the bridge configuration first|bridge metadata ready/);
            assert.deepEqual(await snapshotBusinessData(), before);
            const [reminders] = await database.query('SELECT to_regclass(:table) AS name', {replacements: {table: schema + '.appointment_reminder_deliveries'}});
            assert.ok((reminders[0] as any).name, 'The new reminder migration must be applied');
            const [versions] = await database.query(`SELECT version FROM ${quote(schema)}.schema_migrations`);
            assert.ok((versions as Array<{version: string}>).some(row => row.version === '20261028-appointment-reminders-v1'));
        });
        await t.test('unchanged redeploys skip completed work and preserve legacy migration timestamps', async () => {
            assert.match(await runCli(), /"noop":true/);
            assert.deepEqual(await snapshotBusinessData(), before);
        });
        await t.test('startup reconciles a tenant registered by old code after pre-deploy without another manual command', async () => {
            const lateTenantId = randomUUID(), lateSchema = 'rehablo_' + lateTenantId.replaceAll('-', '');
            schemas.add(lateSchema);
            await insertTenant(lateTenantId);
            const output = await runServer();
            assert.match(output, /"tenants":1/);
            const [rows] = await database.query('SELECT "releaseId" FROM public.tenant_schema_state WHERE "schemaName"=:schema', {replacements: {schema: lateSchema}});
            assert.equal((rows[0] as any)?.releaseId, databaseManifest.id);
            assert.deepEqual(await snapshotBusinessData(), before);
        });
        await t.test('startup applies pending migrations without any pre-deploy configuration', async () => {
            // Reconstruct a pending tenant step and its missing compatibility checkpoint, as on an interrupted upgrade.
            // All previously recorded business migrations and the other tenant's committed checkpoint remain intact.
            await database.transaction(async transaction => {
                await database.query(`DROP TABLE ${quote(schema)}.appointment_reminder_deliveries`, {transaction});
                await database.query(`DELETE FROM ${quote(schema)}.schema_migrations WHERE version='20261028-appointment-reminders-v1'`, {transaction});
                await database.query('DELETE FROM public.tenant_schema_state WHERE "schemaName"=:schema', {transaction, replacements: {schema}});
                await database.query('DELETE FROM public.schema_control', {transaction});
                await database.query('DELETE FROM public.schema_releases WHERE id=:id', {transaction, replacements: {id: databaseManifest.id}});
            });
            const previousPhase = process.env.DATABASE_MIGRATION_PHASE;
            delete process.env.DATABASE_MIGRATION_PHASE;
            try {
                const output = await runServer();
                assert.match(output, /"noop":false/);
                assert.match(output, /20261028-appointment-reminders-v1/);
            } finally {
                if (previousPhase === undefined) delete process.env.DATABASE_MIGRATION_PHASE;
                else process.env.DATABASE_MIGRATION_PHASE = previousPhase;
            }
            const [tables] = await database.query('SELECT to_regclass(:table) AS name', {replacements: {table: schema + '.appointment_reminder_deliveries'}});
            assert.ok((tables[0] as any).name, 'Startup must apply the pending reminder DDL before serving traffic');
            const [versions] = await database.query(`SELECT version FROM ${quote(schema)}.schema_migrations WHERE version='20261028-appointment-reminders-v1'`);
            assert.equal(versions.length, 1, 'Startup must record the actual applied migration');
            assert.deepEqual(await snapshotBusinessData(), before);
        });
    } finally {
        try {
            if (ownsFixture) {
                for (const ownedSchema of schemas) await database.query('DROP SCHEMA IF EXISTS ' + quote(ownedSchema) + ' CASCADE');
                const [tables] = await database.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
                for (const row of tables as Array<{tablename: string}>) {
                    assert.ok(knownTables.has(row.tablename), 'Unexpected table is not owned by the legacy fixture: ' + row.tablename);
                    await database.query('DROP TABLE public.' + quote(row.tablename) + ' CASCADE');
                }
                const [types] = await database.query(`SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e'`);
                for (const row of types as Array<{typname: string}>) {
                    assert.ok(knownEnums.has(row.typname), 'Unexpected enum is not owned by the legacy fixture: ' + row.typname);
                    await database.query('DROP TYPE public.' + quote(row.typname));
                }
            }
        } finally {
            await database.close();
            unlinkSync(noSyncGuard);
            rmdirSync(temporaryDirectory);
        }
    }
});

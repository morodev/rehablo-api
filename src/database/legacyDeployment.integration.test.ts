import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {get} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {test} from 'node:test';
import type {Sequelize, Transaction} from 'sequelize';
import {requireMigrationsTestDatabase} from '../../scripts/test-database-migrations-integration.mjs';

test('legacy deployments upgrade directly and preserve existing business data', {timeout: 180000}, async t => {
    const target = requireMigrationsTestDatabase(process.env);
    Object.assign(process.env, {DATABASE_URL: target.databaseUrl, NODE_ENV: 'production', DB_SSL: 'false',
        DATABASE_MIGRATION_PHASE: 'bridge', TENANT_SCHEMA_SYNC: 'additive',
        JWT_SECRET: randomBytes(32).toString('hex'), DEVICE_CREDENTIALS_SECRET: randomBytes(32).toString('hex'),
        BACKGROUND_JOBS_ENABLED: 'false', ACTIVITIES_DELIVERY_ENABLED: 'false', REMINDER_EXTERNAL_DELIVERY_ENABLED: 'false'});
    const directory = fileURLToPath(new URL('../..', import.meta.url));
    const cli = join(directory, 'node_modules/sequelize-cli/lib/sequelize');
    const script = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).scripts['db:migrate'];
    const command: string[] = script.match(/"[^"]*"|'[^']*'|[^\s]+/g).map((argument: string) => argument.replace(/^(['"])(.*)\1$/, '$2'));
    assert.ok(['sequelize', 'sequelize-cli'].includes(command.shift()!), 'db:migrate must invoke the official CLI');
    assert.ok(existsSync(cli), 'Build the deployment artifact before running legacy deployment tests');
    const {sequelize: database} = await import('../config/database.js');
    const {registerDatabaseModels} = await import('./registerModels.js');
    const {getTenantScopedModels} = await import('../utils/tenantSchema.js');
    const {tenantMigrations, prepareTenantPaymentHistory, runTenantMigrations} = await import('../utils/tenantMigrations.js');
    const {requiredMigrationNames} = await import('./standardMigrations.js');
    const {schemaBaseline} = await import('./schemaBaseline.js');
    registerDatabaseModels();
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'rehablo-legacy-deployment-'));
    const noSyncGuard = join(temporaryDirectory, 'forbid-runtime-sync.mjs');
    writeFileSync(noSyncGuard, `import {createRequire} from 'node:module';
const require = createRequire(${JSON.stringify(join(directory, 'package.json'))});
const {Model, Sequelize} = require('sequelize');
const originalSync = Model.sync;
Model.sync = function(options) {
    if (this.tableName !== 'SequelizeMeta') throw new Error('Business model sync is forbidden: ' + this.tableName);
    return originalSync.call(this, options);
};
Sequelize.prototype.sync = function() {throw new Error('Global model sync is forbidden');};
`);
    const tenantId = randomUUID(), patientId = randomUUID(), structureId = randomUUID();
    const eventId = randomUUID(), evaluationId = randomUUID(), accountId = randomUUID();
    const invoiceId = randomUUID(), paymentId = randomUUID();
    const schema = 'rehablo_' + tenantId.replaceAll('-', '');
    const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    const legacyForeignKeys = [
        {schema: 'public', table: 'user_emails', column: 'userId', target: 'users', update: 'NO ACTION'},
        {schema: 'public', table: 'patient_portal_accesses', column: 'userId', target: 'users', update: 'NO ACTION'},
        {schema: 'public', table: 'patient_portal_accesses', column: 'tenantId', target: 'tenants', update: 'NO ACTION'},
        {schema: 'public', table: 'patient_portal_invitations', column: 'tenantId', target: 'tenants', update: 'NO ACTION'},
        {schema, table: 'invoice_payments', column: 'invoiceId', target: 'invoices', update: 'CASCADE'},
        {schema, table: 'activity_push_targets', column: 'deliveryId', target: 'activity_deliveries', update: 'CASCADE'}
    ];
    const readForeignKey = async (key: typeof legacyForeignKeys[number], transaction?: Transaction) => {
        const [rows] = await database.query(`SELECT c.oid,c.conname,pg_get_constraintdef(c.oid) AS definition,
            n.nspname AS "targetSchema",t.relname AS "targetTable",c.confdeltype AS "onDelete",c.confupdtype AS "onUpdate"
            FROM pg_constraint c JOIN pg_class t ON t.oid=c.confrelid JOIN pg_namespace n ON n.oid=t.relnamespace
            WHERE c.contype='f' AND c.conrelid=to_regclass(:table)
              AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname=:column)] ORDER BY c.oid`,
        {transaction, replacements: {table: quote(key.schema) + '.' + quote(key.table), column: key.column}});
        return rows as Array<{oid: number; conname: string; definition: string; targetSchema: string; targetTable: string; onDelete: string; onUpdate: string}>;
    };
    const reconstructLegacyForeignKey = async (key: typeof legacyForeignKeys[number], transaction?: Transaction) => {
        const existing = await readForeignKey(key, transaction);
        assert.equal(existing.length, 1, 'Fixture starts with exactly one model-generated foreign key');
        const table = quote(key.schema) + '.' + quote(key.table);
        await database.query(`ALTER TABLE ${table} DROP CONSTRAINT ${quote(existing[0].conname)}`, {transaction});
        await database.query(`ALTER TABLE ${table} ADD CONSTRAINT ${quote(existing[0].conname)}
            FOREIGN KEY (${quote(key.column)}) REFERENCES ${quote(key.schema)}.${quote(key.target)}(id)
            ON DELETE CASCADE ON UPDATE ${key.update}`, {transaction});
    };
    const schemas = new Set([schema]);
    const knownTables = new Set([...schemaBaseline.public.map(table => table.name),
        'SequelizeMeta','schema_migrations','schema_control','schema_releases','tenant_schema_state','platform_schema_migrations','schema_transition',
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
        const {child, output} = spawnArtifact(cli, command);
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
            assert.doesNotMatch(output(), /sync modello|public auth models|Business model sync is forbidden|Global model sync is forbidden/);
            return output();
        } finally {await stop(child);}
    };
    const snapshotBusinessData = async (connection: Sequelize = database) => {
        const [patients] = await connection.query(`SELECT id,name,surname,emails,"phoneNumbers" FROM ${quote(schema)}.patients WHERE id=:id`, {replacements: {id: patientId}});
        const [events] = await connection.query(`SELECT id,"appointmentPaymentStatus","appointmentPaidAmount","appointmentExpectedAmount","appointmentPaymentHistoryKnown"
            FROM ${quote(schema)}.agenda_events WHERE id=:id`, {replacements: {id: eventId}});
        const [evaluations] = await connection.query(`SELECT id,"publishedToPatient" FROM ${quote(schema)}.evaluations WHERE id=:id`, {replacements: {id: evaluationId}});
        const [accounts] = await connection.query(`SELECT id,name,"openingBalance" FROM ${quote(schema)}.financial_accounts WHERE id=:id`, {replacements: {id: accountId}});
        const [invoices] = await connection.query(`SELECT * FROM ${quote(schema)}.invoices WHERE id=:id`, {replacements: {id: invoiceId}});
        const [payments] = await connection.query(`SELECT * FROM ${quote(schema)}.invoice_payments WHERE id=:id`, {replacements: {id: paymentId}});
        const [versions] = await connection.query(`SELECT version,"appliedAt" FROM ${quote(schema)}.schema_migrations
            WHERE version IN (:versions) ORDER BY version`, {replacements: {versions: [...tenantMigrations.map(step => step.version), '20261026-tenant-model-baseline-v21']}});
        const foreignKeys = await Promise.all(legacyForeignKeys.map(key => readForeignKey(key)));
        return {patients, events, evaluations, accounts, invoices, payments, versions, foreignKeys};
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
        // The 20260901 portal SQL used ON DELETE CASCADE and omitted ON UPDATE.
        // Reconstruct those deployed constraints instead of inheriting today's model defaults.
        for (const key of legacyForeignKeys.filter(key => key.schema === 'public')) await reconstructLegacyForeignKey(key);
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
            // cc78bbc required invoiceId: Sequelize inferred DELETE/UPDATE CASCADE.
            // 07a1ff4 made it nullable; the ledger migration drops NOT NULL without replacing this FK.
            await database.query(`ALTER TABLE ${quote(schema)}.invoice_payments ALTER COLUMN "invoiceId" SET NOT NULL`, {transaction});
            const paymentKey = legacyForeignKeys.find(key => key.table === 'invoice_payments')!;
            await reconstructLegacyForeignKey(paymentKey, transaction);
            const originalPaymentForeignKey = await readForeignKey(paymentKey, transaction);
            await runTenantMigrations(schema, repair, database, transaction);
            // Reconstruct the Sequelize-generated CASCADE key reported by Render. This fixture
            // covers a single key; the baseline tests also cover both historical keys coexisting.
            await database.query(`ALTER TABLE ${quote(schema)}.activity_push_targets
                DROP CONSTRAINT activity_push_targets_delivery_fkey`, {transaction});
            await reconstructLegacyForeignKey(legacyForeignKeys.find(key => key.table === 'activity_push_targets')!, transaction);
            const [nullable] = await database.query(`SELECT is_nullable FROM information_schema.columns
                WHERE table_schema=:schema AND table_name='invoice_payments' AND column_name='invoiceId'`,
                {transaction, replacements: {schema}});
            assert.deepEqual(nullable, [{is_nullable: 'YES'}], 'The real historical ledger migration must remove NOT NULL');
            assert.deepEqual(await readForeignKey(paymentKey, transaction), originalPaymentForeignKey,
                'The historical nullable transition must preserve the original CASCADE foreign key and its OID');
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
        await database.query(`INSERT INTO ${quote(schema)}.invoices(id,"structureId","invoiceTotal",status,"createdAt","updatedAt")
            VALUES (:id,:structure,80.50,'issued','2026-09-01T10:00:00Z','2026-09-01T10:00:00Z')`,
            {replacements: {id: invoiceId, structure: structureId}});
        await database.query(`INSERT INTO ${quote(schema)}.invoice_payments
            (id,"invoiceId",amount,"paidAt",source,status,note,"createdAt","updatedAt")
            VALUES (:id,:invoice,35.25,'2026-09-02','LEGACY_IMPORT','POSTED','Preserve historical receipt',
                '2026-09-02T10:00:00Z','2026-09-02T10:00:00Z')`, {replacements: {id: paymentId, invoice: invoiceId}});
        const before = await snapshotBusinessData();
        for (const [index, key] of legacyForeignKeys.entries()) {
            assert.equal(before.foreignKeys[index].length, 1);
            const actual = before.foreignKeys[index][0];
            assert.equal(actual.targetSchema, key.schema);
            assert.equal(actual.targetTable, key.target);
            assert.equal(actual.onDelete, 'c');
            assert.equal(actual.onUpdate, key.update === 'CASCADE' ? 'c' : 'a');
        }
        const additionalTenants = [randomUUID(), randomUUID()];
        for (const additional of additionalTenants) {
            schemas.add('rehablo_' + additional.replaceAll('-', ''));
            await insertTenant(additional);
        }

        await t.test('official CLI adopts historical foreign keys without rewriting their OIDs, actions or business data', async () => {
            const output = await runCli();
            assert.match(output, /== 202610280001-initial-schema: migrated/);
            assert.doesNotMatch(output, /Deploy the bridge configuration first|bridge metadata ready/);
            assert.deepEqual(await snapshotBusinessData(), before);
            const [reminders] = await database.query('SELECT to_regclass(:table) AS name', {replacements: {table: schema + '.appointment_reminder_deliveries'}});
            assert.ok((reminders[0] as any).name, 'The new reminder migration must be applied');
            const [versions] = await database.query(`SELECT name FROM ${quote(schema)}."SequelizeMeta" ORDER BY name`);
            assert.deepEqual((versions as Array<{name: string}>).map(row => row.name), requiredMigrationNames);
            for (const additional of additionalTenants) {
                const additionalSchema = 'rehablo_' + additional.replaceAll('-', '');
                const [markers] = await database.query(`SELECT name FROM ${quote(additionalSchema)}."SequelizeMeta" ORDER BY name`);
                assert.deepEqual((markers as Array<{name: string}>).map(row => row.name), requiredMigrationNames);
            }
        });
        await t.test('unchanged redeploys skip completed work and preserve legacy migration timestamps', async () => {
            await runCli();
            assert.deepEqual(await snapshotBusinessData(), before);
        });
        await t.test('startup reconciles a tenant registered by old code after pre-deploy without another manual command', async () => {
            const lateTenantId = randomUUID(), lateSchema = 'rehablo_' + lateTenantId.replaceAll('-', '');
            schemas.add(lateSchema);
            await insertTenant(lateTenantId);
            const output = await runServer();
            assert.doesNotMatch(output, /Business model sync is forbidden|Global model sync is forbidden/);
            const [rows] = await database.query(`SELECT name FROM ${quote(lateSchema)}."SequelizeMeta" ORDER BY name`);
            assert.deepEqual((rows as Array<{name: string}>).map(row => row.name), requiredMigrationNames);
            assert.deepEqual(await snapshotBusinessData(), before);
        });
        await t.test('startup rejects pending global migrations instead of applying them itself', async () => {
            await database.query('DELETE FROM public."SequelizeMeta" WHERE name=:name', {replacements: {name: requiredMigrationNames[1]}});
            const {child, output} = spawnArtifact(fileURLToPath(new URL('../../dist/server.js', import.meta.url)));
            const timer = setTimeout(() => child.kill(), 15000);
            try {
                const code = await new Promise<number | null>((resolve, reject) => {
                    child.once('error', reject); child.once('close', resolve);
                });
                assert.equal(code, 1, 'Startup must fail while a global migration is pending: ' + output());
                const [markers] = await database.query('SELECT name FROM public."SequelizeMeta" ORDER BY name');
                assert.deepEqual((markers as Array<{name: string}>).map(row => row.name), [requiredMigrationNames[0]]);
                assert.deepEqual(await snapshotBusinessData(), before);
            } finally {clearTimeout(timer); await stop(child);}
            await runCli();
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

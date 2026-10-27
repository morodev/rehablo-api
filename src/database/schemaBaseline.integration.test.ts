import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {Sequelize, type Transaction} from 'sequelize';
import {requireMigrationsTestDatabase} from '../../scripts/test-database-migrations-integration.mjs';

test('PostgreSQL frozen baselines, legacy evidence and catalog seed compatibility', {timeout: 180000}, async t => {
    // Validate isolation before importing application modules or loading application configuration.
    const target = requireMigrationsTestDatabase(process.env);
    process.env.DATABASE_URL = target.databaseUrl;
    process.env.DB_SSL = 'false';
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = randomBytes(32).toString('hex');
    const {applySchemaBaseline, verifySchemaBaseline, schemaBaseline, canonicalIndex} = await import('./schemaBaseline.js');
    const {databaseManifest} = await import('./migrationManifest.js');
    const {publicMigrationSteps} = await import('./publicMigrations.js');
    const {runTenantMigrations} = await import('./releaseRunner.js');
    const {quoteTenantSchema} = await import('./migrationTypes.js');
    const {registerDatabaseModels} = await import('./registerModels.js');
    const {sequelize: modelDatabase} = await import('../config/database.js');
    const database = new Sequelize(target.databaseUrl, {dialect: 'postgres', logging: false,
        dialectOptions: {ssl: false}, pool: {max: 3, min: 0, acquire: 15000}});
    registerDatabaseModels();
    const withRollback = async (work: (transaction: Transaction) => Promise<void>) => {
        const transaction = await database.transaction();
        try {await work(transaction);} finally {await transaction.rollback();}
    };
    const randomSchema = () => 'rehablo_' + randomUUID().replaceAll('-', '');
    try {
        await database.authenticate();
        const [names] = await database.query('SELECT current_database() AS name');
        assert.equal((names[0] as {name: string}).name, target.databaseName);
        const [tables] = await database.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
        assert.equal(tables.length, 0, 'Baseline tests require an empty disposable database; existing tables are never removed');

        await t.test('fresh public and tenant schemas match every frozen model column and survive reapplication', async () => withRollback(async transaction => {
            const schema = randomSchema();
            await applySchemaBaseline('public', 'public', database, transaction);
            await applySchemaBaseline('tenant', schema, database, transaction);
            for (const [scope, schemaName] of [['public', 'public'], ['tenant', schema]] as const) {
                await verifySchemaBaseline(scope, schemaName, database, transaction);
                const [rows] = await database.query(`SELECT table_name,column_name,is_nullable
                    FROM information_schema.columns WHERE table_schema=:schema`, {transaction, replacements: {schema: schemaName}});
                const columns = new Map((rows as Array<{table_name: string;column_name: string;is_nullable: string}>).map(row => [row.table_name + '.' + row.column_name, row]));
                for (const table of schemaBaseline[scope]) {
                    const model = modelDatabase.modelManager.models.find(candidate => candidate.tableName === table.name);
                    assert.ok(model, 'Frozen table must have a registered model: ' + table.name);
                    const expected = Object.entries(model.rawAttributes).map(([name, attribute]) => attribute.field ?? name).sort();
                    assert.deepEqual(table.columns.map(column => column.name).sort(), expected, 'Frozen model parity: ' + table.name);
                    for (const column of table.columns) {
                        const actual = columns.get(table.name + '.' + column.name);
                        assert.ok(actual, 'Fresh schema is missing ' + table.name + '.' + column.name);
                        if (!column.nullable) assert.equal(actual.is_nullable, 'NO', table.name + '.' + column.name);
                    }
                }
            }
            // Semantic index/constraint recognition must make a second baseline application harmless.
            await applySchemaBaseline('public', 'public', database, transaction);
            await applySchemaBaseline('tenant', schema, database, transaction);
        }));

        await t.test('the manifest captures legacy payment evidence before adding current defaults and preserves old migration markers', async () => withRollback(async transaction => {
            const tenantId = randomUUID(), schema = 'rehablo_' + tenantId.replaceAll('-', ''), prefix = quoteTenantSchema(schema);
            await applySchemaBaseline('public', 'public', database, transaction);
            await database.query(`INSERT INTO public.tenants (id,license,"idStripe","maxUserQuantity","maxStructureQuantity","createdAt","updatedAt")
                VALUES (:id,'synthetic-baseline-test','synthetic',1,1,NOW(),NOW())`, {transaction, replacements: {id: tenantId}});
            await applySchemaBaseline('tenant', schema, database, transaction, {constraints: false});
            // Reconstruct a real pre-upgrade shape while retaining all unrelated legacy columns.
            await database.query(`ALTER TABLE ${prefix}.agenda_events DROP COLUMN "appointmentPaymentHistoryKnown"`, {transaction});
            await database.query(`ALTER TABLE ${prefix}.invoice_payments ALTER COLUMN "invoiceId" SET NOT NULL`, {transaction});
            await database.query(`ALTER TABLE ${prefix}.patients DROP COLUMN color`, {transaction});
            const eventId = randomUUID(), patientId = randomUUID(), evaluationId = randomUUID();
            await database.query(`INSERT INTO ${prefix}.agenda_events (id,status,"createdAt","updatedAt")
                VALUES (:id,'CONFIRMED',NOW(),NOW())`, {transaction, replacements: {id: eventId}});
            await database.query(`INSERT INTO ${prefix}.patients (id,"tenantId","userId","structureId",name,"createdAt","updatedAt")
                VALUES (:id,:tenant,:user,:structure,'Preserve this patient',NOW(),NOW())`, {transaction,
                replacements: {id: patientId, tenant: randomUUID(), user: randomUUID(), structure: randomUUID()}});
            await database.query(`INSERT INTO ${prefix}.evaluations (id,"patientId","userId",date,status,"publishedToPatient","createdAt","updatedAt")
                VALUES (:id,:patient,:user,NOW(),'COMPLETED',false,NOW(),NOW())`, {transaction,
                replacements: {id: evaluationId, patient: patientId, user: randomUUID()}});
            await database.query(`CREATE TABLE ${prefix}.schema_migrations (version VARCHAR(160) PRIMARY KEY,"appliedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`, {transaction});
            await database.query(`INSERT INTO ${prefix}.schema_migrations (version,"appliedAt")
                VALUES ('20260924-backfill-patient-publication','2026-09-24T00:00:00Z')`, {transaction});
            await runTenantMigrations(databaseManifest, schema, database, transaction);
            await verifySchemaBaseline('tenant', schema, database, transaction);
            const [oldEvents] = await database.query(`SELECT "appointmentPaymentHistoryKnown" FROM ${prefix}.agenda_events WHERE id=:id`,
                {transaction, replacements: {id: eventId}});
            assert.equal((oldEvents[0] as any).appointmentPaymentHistoryKnown, false, 'Existing appointments without evidence cannot become verified');
            const newEvent = randomUUID();
            await database.query(`INSERT INTO ${prefix}.agenda_events (id,"createdAt","updatedAt") VALUES (:id,NOW(),NOW())`,
                {transaction, replacements: {id: newEvent}});
            const [newEvents] = await database.query(`SELECT "appointmentPaymentHistoryKnown" FROM ${prefix}.agenda_events WHERE id=:id`,
                {transaction, replacements: {id: newEvent}});
            assert.equal((newEvents[0] as any).appointmentPaymentHistoryKnown, true, 'New appointments use the current contract');
            const [patients] = await database.query(`SELECT name,color FROM ${prefix}.patients WHERE id=:id`, {transaction, replacements: {id: patientId}});
            assert.equal((patients[0] as any).name, 'Preserve this patient');
            assert.equal((patients[0] as any).color, null);
            const [evaluations] = await database.query(`SELECT "publishedToPatient" FROM ${prefix}.evaluations WHERE id=:id`, {transaction, replacements: {id: evaluationId}});
            assert.equal((evaluations[0] as any).publishedToPatient, false, 'Completed publication backfills must not override later privacy decisions');
            const [markers] = await database.query(`SELECT "appliedAt" FROM ${prefix}.schema_migrations
                WHERE version='20260924-backfill-patient-publication'`, {transaction});
            assert.equal(new Date((markers[0] as any).appliedAt).toISOString(), '2026-09-24T00:00:00.000Z');
            const applied = await runTenantMigrations(databaseManifest, schema, database, transaction);
            assert.equal(applied, 0, 'The completed tenant migration sequence is not replayed');
        }));

        await t.test('public preparation repairs unrecoverable availability before the baseline adds columns', async () => withRollback(async transaction => {
            await applySchemaBaseline('public', 'public', database, transaction);
            const userId = randomUUID(), availabilityId = randomUUID();
            await database.query(`INSERT INTO public.users (id,email,password,"createdAt","updatedAt")
                VALUES (:id,'synthetic-availability@example.invalid','synthetic',NOW(),NOW())`, {transaction, replacements: {id: userId}});
            await database.query('ALTER TABLE public.user_availabilities DROP COLUMN "rangeOneFinish"', {transaction});
            await database.query(`INSERT INTO public.user_availabilities (id,"userId",day,enabled,"rangeOneStart","createdAt","updatedAt")
                VALUES (:id,:user,1,true,'09:00',NOW(),NOW())`, {transaction, replacements: {id: availabilityId, user: userId}});
            await databaseManifest.publicMigrations[0].up(database, 'public', transaction);
            const [rows] = await database.query('SELECT enabled,"rangeOneStart","rangeOneFinish" FROM public.user_availabilities WHERE id=:id',
                {transaction, replacements: {id: availabilityId}});
            assert.deepEqual(rows[0], {enabled: false, rangeOneStart: null, rangeOneFinish: null});
        }));

        await t.test('a fresh provision runs the complete tenant manifest in the caller transaction', async () => withRollback(async transaction => {
            const tenantId = randomUUID(), schema = 'rehablo_' + tenantId.replaceAll('-', '');
            await applySchemaBaseline('public', 'public', database, transaction);
            await database.query(`INSERT INTO public.tenants (id,license,"idStripe","maxUserQuantity","maxStructureQuantity","createdAt","updatedAt")
                VALUES (:id,'synthetic-new-tenant','synthetic',1,1,NOW(),NOW())`, {transaction, replacements: {id: tenantId}});
            assert.equal(await runTenantMigrations(databaseManifest, schema, database, transaction), databaseManifest.tenantMigrations.length);
            await verifySchemaBaseline('tenant', schema, database, transaction);
            const [markers] = await database.query(`SELECT version FROM ${quoteTenantSchema(schema)}.schema_migrations`, {transaction});
            assert.deepEqual((markers as Array<{version: string}>).map(row => row.version).sort(), databaseManifest.tenantMigrations.map(step => step.name).sort());
        }));

        await t.test('existing incompatible index predicates and column types require an explicit migration', async () => withRollback(async transaction => {
            const schema = randomSchema(), prefix = quoteTenantSchema(schema);
            await applySchemaBaseline('public', 'public', database, transaction);
            await applySchemaBaseline('tenant', schema, database, transaction);
            await database.query(`DROP INDEX ${prefix}.reminders_personal_contacts_active_unique`, {transaction});
            await database.query(`CREATE UNIQUE INDEX reminders_personal_contacts_active_unique ON ${prefix}.reminders
                ("createdByUserId","patientId","structureId") WHERE "sourceType"='OTHER'`, {transaction});
            await assert.rejects(applySchemaBaseline('tenant', schema, database, transaction), /Incompatible index/);
            await database.query(`DROP INDEX ${prefix}.reminders_personal_contacts_active_unique`, {transaction});
            await database.query(`CREATE UNIQUE INDEX reminders_personal_contacts_active_unique ON ${prefix}.reminders
                ("createdByUserId","patientId","structureId") WHERE "sourceType"='patient_missing_contacts'
                    AND status IN ('OPEN','SNOOZED') AND "deletedAt" IS NULL`, {transaction});
            await assert.rejects(applySchemaBaseline('tenant', schema, database, transaction), /Incompatible index/,
                'Literal case changes the partial-index predicate and must not be normalized away');
            await database.query(`ALTER TABLE ${prefix}.patients ALTER COLUMN color TYPE TEXT`, {transaction});
            await assert.rejects(verifySchemaBaseline('tenant', schema, database, transaction), /patients.color/);
            const index = (predicate: string) => `CREATE INDEX "test_index" ON "public"."test_table" ("id") WHERE ${predicate}`;
            assert.notEqual(canonicalIndex(index('"status"=\'OPEN\'')), canonicalIndex(index('"status"=\'open\'')));
            assert.notEqual(canonicalIndex(index('"label"=\'A B\'')), canonicalIndex(index('"label"=\'AB\'')));
            assert.notEqual(canonicalIndex(index('"camelCase" IS NULL')), canonicalIndex(index('"camelcase" IS NULL')));
        }));

        await t.test('versioned catalog seeds preserve JSON arrays, model defaults and existing catalog edits', async () => withRollback(async transaction => {
            await applySchemaBaseline('public', 'public', database, transaction);
            const seeds = publicMigrationSteps().filter(step => step.name.includes('seed-v1'));
            assert.equal(seeds.length, 2);
            for (const seed of seeds) await seed.up(database, 'public', transaction);
            const [metrics] = await database.query(`SELECT "applicableDistricts","applicableSides","dataType","isActive"
                FROM public.metric_definitions WHERE code='KNEE_EXT_PEAK_FORCE'`, {transaction});
            assert.deepEqual(metrics[0], {applicableDistricts: ['knee'], applicableSides: ['LEFT','RIGHT'], dataType: 'NUMBER', isActive: true});
            const [devices] = await database.query(`SELECT channels,"producesMetrics" FROM public.device_sources WHERE "sourceId"='generic-manual-dynamometer'`, {transaction});
            assert.deepEqual((devices[0] as any).channels, ['MANUAL']);
            assert.deepEqual((devices[0] as any).producesMetrics, ['KNEE_EXT_PEAK_FORCE','KNEE_FLEX_PEAK_FORCE']);
            const [profiles] = await database.query('SELECT definition FROM public.import_profiles LIMIT 1', {transaction});
            assert.equal(typeof (profiles[0] as any).definition, 'object');
            await database.query(`UPDATE public.metric_definitions SET "displayName"='Custom catalog label' WHERE code='KNEE_EXT_PEAK_FORCE'`, {transaction});
            for (const seed of seeds) await seed.up(database, 'public', transaction);
            const [labels] = await database.query(`SELECT "displayName",COUNT(*) OVER ()::int AS count
                FROM public.metric_definitions WHERE code='KNEE_EXT_PEAK_FORCE'`, {transaction});
            assert.deepEqual(labels[0], {displayName: 'Custom catalog label', count: 1});
        }));
    } finally {
        await database.close();
        await modelDatabase.close();
    }
});

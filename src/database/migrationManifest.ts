import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import type {Sequelize, Transaction} from 'sequelize';
import {prepareTenantPaymentHistory, tenantMigrations} from '../utils/tenantMigrations.js';
import {publicMigrationSteps} from './publicMigrations.js';
import {applySchemaBaseline, schemaBaseline} from './schemaBaseline.js';
import type {DatabaseManifest, MigrationStep} from './migrationTypes.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const require = createRequire(import.meta.url);
const migrationSource = (filename: string) => readFileSync(new URL('../../migrations/' + filename, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const baselineChecksum = digest(migrationSource('baselines/20261028-schema.json'));
const historyRepairs = new WeakMap<Transaction, boolean>();
const step = (name: string, scope: 'public' | 'tenant', checksum: string,
    up: MigrationStep['up']): MigrationStep => ({name, scope, checksum: digest(name + ':' + checksum), up});

const publicSteps = publicMigrationSteps();
const availabilityRepair = publicSteps.find(migration => migration.name.includes('availability-repair'))!;
if (!availabilityRepair) throw new Error('The conservative availability migration must precede the structural baseline');

const publicMigrations: MigrationStep[] = [
    {...availabilityRepair, up: async (database, schema, transaction) => {
        const [rows] = await database.query("SELECT to_regclass('public.user_availabilities') AS existing", {transaction});
        if ((rows[0] as any)?.existing) await availabilityRepair.up(database, schema, transaction);
    }},
    step('20261028-public-schema-baseline-v1', 'public', baselineChecksum,
        (database, schema, transaction) => applySchemaBaseline('public', schema, database, transaction, {constraints: false})),
    ...publicSteps.filter(migration => migration !== availabilityRepair),
    step('20261028-public-schema-constraints-v1', 'public', baselineChecksum,
        (database, schema, transaction) => applySchemaBaseline('public', schema, database, transaction))
];

const tenantSteps: MigrationStep[] = [
    step('20261028-tenant-schema-baseline-v1', 'tenant', baselineChecksum, async (database, schema, transaction) => {
        // Capture historical evidence before adding model defaults or relaxing old invoice columns.
        historyRepairs.set(transaction, await prepareTenantPaymentHistory(schema, database, transaction));
        await applySchemaBaseline('tenant', schema, database, transaction, {constraints: false});
    }),
    ...tenantMigrations.map(migration => {
        const filename = migration.version === '20260922-seed-administration'
            ? '20261025-seed-administration-safe.js' : migration.version + '.js';
        return step(migration.version, 'tenant', digest(migrationSource(filename)),
            (database, schema, transaction) => migration.module.up(database.getQueryInterface(), {
                schema, transaction, repairHistoryKnown: historyRepairs.get(transaction) ?? false
            }));
    }),
    step('20261028-tenant-structure-backfill-v1', 'tenant', digest(migrationSource('20261028-structure-backfill.js')), async (database, schema, transaction) => {
        const [rows] = await database.query(`SELECT id,"businessName" FROM public.tenants
            WHERE 'rehablo_' || replace(id::text,'-','')=:schema`, {transaction, replacements: {schema}});
        const tenant = rows[0] as {id: string; businessName?: string} | undefined;
        if (!tenant) throw new Error(`No tenant owns schema ${schema}`);
        await require('../../migrations/20261028-structure-backfill.js').runStructureBackfillTenant({
            tenantId: tenant.id, businessName: tenant.businessName ?? null, database, transaction
        });
    }),
    step('20261028-tenant-schema-constraints-v1', 'tenant', baselineChecksum,
        (database, schema, transaction) => applySchemaBaseline('tenant', schema, database, transaction)),
    step('20261028-appointment-reminders-v1', 'tenant', digest(migrationSource('20261028-appointment-reminders.js')),
        (database, schema, transaction) => require('../../migrations/20261028-appointment-reminders.js')
            .up(database.getQueryInterface(), {schema, transaction}))
];

const manifestContent = {publicMigrations: publicMigrations.map(({name, checksum}) => ({name, checksum})),
    tenantMigrations: tenantSteps.map(({name, checksum}) => ({name, checksum}))};

/** Immutable DB revision, independent of application commit/build number. Append migrations for future releases. */
export const databaseManifest: DatabaseManifest = {
    id: '20261028-appointment-reminders-v1', checksum: digest(JSON.stringify(manifestContent)),
    publicMigrations, tenantMigrations: tenantSteps
};

/** Bridge state is deliberately distinct: legacy model sync does not prove the explicit baseline was verified. */
export const bridgeManifest: DatabaseManifest = {
    id: '20261028-schema-bridge-v1', checksum: digest('bridge-v1:' + schemaBaseline.version),
    publicMigrations: [], tenantMigrations: []
};

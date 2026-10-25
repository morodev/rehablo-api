import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {sequelize} from '../config/database.js';
import {lockTenantSchema, SOCIAL_SECURITY_PRICING_VERSION} from '../utils/tenantMigrations.js';
const require = createRequire(import.meta.url);
const migration = require('../../migrations/20261023-social-security-pricing.js');
export function parseSocialSecurityMigrationArguments(flags: string[]) {
    if (flags.length === 1 && flags[0] === '--help') return {help: true, apply: false};
    if (!flags.length || (flags.length === 1 && flags[0] === '--check')) return {help: false, apply: false};
    if (flags.length === 1 && flags[0] === '--apply') return {help: false, apply: true};
    throw Error('Use --check (default) or --apply');
}
async function main() {
    const options = parseSocialSecurityMigrationArguments(process.argv.slice(2));
    if (options.help) {console.log('Usage: npm run migrate:social-security -- [--check | --apply]. No financial records are recalculated.'); return;}
    await sequelize.authenticate();
    const [rows] = await sequelize.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name ~ '^rehablo_[a-f0-9]{32}$' ORDER BY schema_name");
    const schemas = (rows as Array<{schema_name: string}>).map(row => row.schema_name);
    if (options.apply) await sequelize.transaction(async transaction => {
        for (const schema of schemas) await lockTenantSchema(sequelize, schema, transaction);
        await migration.up(sequelize.getQueryInterface(), {transaction});
        for (const schema of schemas) {
            const [registry] = await sequelize.query('SELECT to_regclass(:registry) AS registry', {transaction, replacements: {registry: `"${schema}"."schema_migrations"`}});
            if ((registry[0] as any)?.registry) await sequelize.query(`INSERT INTO "${schema}"."schema_migrations" ("version") VALUES (:version) ON CONFLICT ("version") DO NOTHING`,
                {transaction, replacements: {version: SOCIAL_SECURITY_PRICING_VERSION}});
        }
    });
    const [columns] = await sequelize.query(`SELECT table_schema, table_name, column_name FROM information_schema.columns
        WHERE (table_schema = 'public' AND table_name = 'tenants' AND column_name IN ('socialSecurityPricingMode','withholdingType','withholdingCausale'))
        OR (table_schema ~ '^rehablo_[a-f0-9]{32}$' AND column_name IN ('socialSecuritySnapshot','socialSecurity','appointmentSocialSecurity'))`);
    const present = new Set((columns as any[]).map(row => `${row.table_schema}.${row.table_name}.${row.column_name}`));
    const required = ['socialSecurityPricingMode', 'withholdingType', 'withholdingCausale'].map(column => `public.tenants.${column}`);
    for (const schema of schemas) required.push(`${schema}.invoices.socialSecuritySnapshot`, `${schema}.invoice_services.socialSecurity`, `${schema}.agenda_events.appointmentSocialSecurity`);
    const missing = required.filter(column => !present.has(column));
    console.log(JSON.stringify({mode: options.apply ? 'apply' : 'check', tenantCount: schemas.length, missingColumns: missing, ready: !missing.length}));
    if (missing.length) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {console.error(error.message); process.exitCode = 1;}).finally(() => sequelize.close());
}

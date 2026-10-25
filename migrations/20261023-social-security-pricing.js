'use strict';
// Additive only: historical fiscal and customer amounts are never rewritten.
module.exports = {
    async up(queryInterface, options = {}) {
        const transaction = options.transaction;
        if (!options.schema) {
            for (const [name, type, defaultValue] of [
                ['socialSecurityPricingMode', 'VARCHAR(16)', "'EXCLUDED'"],
                ['withholdingType', 'VARCHAR(4)', 'NULL'], ['withholdingCausale', 'VARCHAR(2)', 'NULL']
            ]) await queryInterface.sequelize.query('ALTER TABLE "public"."tenants" ADD COLUMN IF NOT EXISTS "' + name + '" ' + type + ' DEFAULT ' + defaultValue, {transaction});
        }
        const schemas = options.schema ? [options.schema] : (await queryInterface.sequelize.query(
            "SELECT schema_name FROM information_schema.schemata WHERE schema_name ~ '^rehablo_[a-f0-9]{32}$'", {transaction}))[0].map(row => row.schema_name);
        for (const schema of schemas) {
            if (!/^rehablo_[a-f0-9]{32}$/.test(schema)) throw Error('Invalid tenant schema');
            for (const [table, column] of [['invoices', 'socialSecuritySnapshot'], ['invoice_services', 'socialSecurity'], ['agenda_events', 'appointmentSocialSecurity']]) {
                await queryInterface.sequelize.query('ALTER TABLE "' + schema + '"."' + table + '" ADD COLUMN IF NOT EXISTS "' + column + '" JSONB', {transaction});
            }
        }
    },
    async down() { throw Error('Fiscal snapshots are retained; rollback application code without deleting history'); }
};

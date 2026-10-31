'use strict';

// Accepted quote descriptions are already frozen financial lines, even without a catalogue link.
// No historical monetary amount, line or catalogue identifier is rewritten.
module.exports = {
    async up(queryInterface, options = {}) {
        const transaction = options.transaction;
        const schemas = options.schema ? [options.schema] : (await queryInterface.sequelize.query(
            "SELECT schema_name FROM information_schema.schemata WHERE schema_name ~ '^rehablo_[a-f0-9]{32}$'", {transaction}))[0].map(row => row.schema_name);
        for (const schema of schemas) {
            if (!/^rehablo_[a-f0-9]{32}$/i.test(schema)) throw Error('Invalid tenant schema');
            for (const [table, column] of [['invoice_services', 'ServiceId'], ['invoice_products', 'ProductId']]) {
                await queryInterface.sequelize.query('ALTER TABLE IF EXISTS "' + schema + '"."' + table + '" ALTER COLUMN "' + column + '" DROP NOT NULL', {transaction});
            }
        }
    },
    async down() { throw Error('Quote invoice snapshots must be retained; use a reviewed corrective migration'); }
};

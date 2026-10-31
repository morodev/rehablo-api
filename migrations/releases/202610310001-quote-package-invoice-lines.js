'use strict';

module.exports = {
    async up(queryInterface, _Sequelize) {
        const {migrateQuotePackageInvoiceLines} = await import('../../dist/database/standardMigrations.js');
        await migrateQuotePackageInvoiceLines(queryInterface.sequelize);
    },
    async down() {
        throw new Error('Quote invoice snapshots must be retained. Use a reviewed corrective migration.');
    }
};

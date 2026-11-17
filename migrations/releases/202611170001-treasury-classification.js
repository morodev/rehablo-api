'use strict';

module.exports = {
    async up(queryInterface, _Sequelize) {
        const {migrateTreasuryClassification} = await import('../../dist/database/standardMigrations.js');
        await migrateTreasuryClassification(queryInterface.sequelize);
    },
    async down() {
        throw new Error('Treasury classification history must be retained. Use a reviewed corrective migration.');
    }
};

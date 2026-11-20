'use strict';
module.exports = {
    async up(queryInterface) {
        const {migrateTreasuryAutomation} = await import('../../dist/database/standardMigrations.js');
        await migrateTreasuryAutomation(queryInterface.sequelize);
    },
    async down() {throw new Error('Treasury classification history must be retained. Use a reviewed corrective migration.');}
};

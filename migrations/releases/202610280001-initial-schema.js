'use strict';

module.exports = {
    async up(queryInterface, _Sequelize) {
        const {migrateInitialSchema} = await import('../../dist/database/standardMigrations.js');
        await migrateInitialSchema(queryInterface.sequelize);
    },
    async down() {
        throw new Error('The initial migration adopts existing business data and cannot be reverted automatically. Use a reviewed corrective migration.');
    }
};

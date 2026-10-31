'use strict';

module.exports = {
    async up(queryInterface, _Sequelize) {
        const {migrateActivityRecurrences} = await import('../../dist/database/standardMigrations.js');
        await migrateActivityRecurrences(queryInterface.sequelize);
    },
    async down() {
        throw new Error('Activity execution history must be retained. Use a reviewed corrective migration.');
    }
};

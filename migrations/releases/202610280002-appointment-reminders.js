'use strict';

module.exports = {
    async up(queryInterface, _Sequelize) {
        const {migrateAppointmentReminders} = await import('../../dist/database/standardMigrations.js');
        await migrateAppointmentReminders(queryInterface.sequelize);
    },
    async down() {
        throw new Error('Appointment reminder delivery history must be preserved. Use a reviewed corrective migration instead of an automatic rollback.');
    }
};

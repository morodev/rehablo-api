'use strict';

module.exports = {
    async up(queryInterface, options = {}) {
        if (!/^rehablo_[a-f0-9]{32}$/i.test(options.schema ?? '')) throw new Error('Invalid tenant schema');
        const prefix = '"' + options.schema + '".';
        const run = sql => queryInterface.sequelize.query(sql, {transaction: options.transaction});
        for (const [name, type] of Object.entries({
            appointmentOriginalAmount: 'DECIMAL(10,2)',
            appointmentPriceAdjustment: 'VARCHAR(16)',
            appointmentPriceAdjustmentNote: 'TEXT',
            appointmentPriceAdjustedBy: 'UUID',
            appointmentPriceAdjustedAt: 'TIMESTAMPTZ'
        })) {
            await run(`ALTER TABLE ${prefix}"agenda_events" ADD COLUMN IF NOT EXISTS "${name}" ${type} NULL`);
        }
        await run(`ALTER TABLE ${prefix}"invoice_services" ADD COLUMN IF NOT EXISTS "originalServicePrice" DECIMAL(10,2) NULL`);
    },
    async down() {
        throw new Error('Price concessions are financial history. Automatic removal is not supported.');
    }
};

module.exports = {
    async up(queryInterface, options) {
        if (!/^rehablo_[a-f0-9]{32}$/i.test(options.schema ?? '')) throw new Error('Invalid tenant schema');
        const prefix = '"' + options.schema + '".';
        const run = sql => queryInterface.sequelize.query(sql, {transaction: options.transaction});
        await run(`ALTER TABLE ${prefix}"agenda_events" ADD COLUMN IF NOT EXISTS "carePackageServiceId" UUID NULL`);
        await run(`ALTER TABLE ${prefix}"package_consumptions" ADD COLUMN IF NOT EXISTS "serviceId" UUID NULL`);
        await run(`CREATE INDEX IF NOT EXISTS "agenda_events_package_service_reservation_idx" ON ${prefix}"agenda_events" ("carePackageId", "carePackageServiceId", "packageReservationStatus")`);
    },
    async down() { throw new Error('Frozen package service history must not be removed automatically.'); }
};

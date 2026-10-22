'use strict';
const VERSION = '20261022-care-package-purchases';
module.exports = {
    VERSION,
    async up(queryInterface, options = {}) {
        if (!/^rehablo_[a-f0-9]{32}$/i.test(options.schema ?? '')) throw new Error('Invalid tenant schema');
        const prefix = '"' + options.schema + '".';
        const run = sql => queryInterface.sequelize.query(sql, {transaction: options.transaction});
        await run(`CREATE TABLE IF NOT EXISTS ${prefix}"package_templates" (
            "id" UUID PRIMARY KEY, "structureId" UUID NOT NULL, "name" VARCHAR(255) NOT NULL,
            "serviceId" UUID NOT NULL, "serviceName" VARCHAR(255) NOT NULL,
            "sessionCount" INTEGER NOT NULL, "totalPrice" DECIMAL(12,2) NOT NULL,
            "validityDays" INTEGER NULL, "isActive" BOOLEAN NOT NULL DEFAULT true,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await run(`ALTER TABLE ${prefix}"care_packages"
            ADD COLUMN IF NOT EXISTS "templateId" UUID NULL,
            ADD COLUMN IF NOT EXISTS "serviceId" UUID NULL,
            ADD COLUMN IF NOT EXISTS "serviceName" VARCHAR(255) NULL,
            ADD COLUMN IF NOT EXISTS "purchasedAt" DATE NULL,
            ADD COLUMN IF NOT EXISTS "invoiceId" UUID NULL,
            ADD COLUMN IF NOT EXISTS "idempotencyKey" VARCHAR(255) NULL,
            ADD COLUMN IF NOT EXISTS "purchaseSnapshot" JSONB NULL`);
        await run(`ALTER TABLE ${prefix}"invoice_payments" ADD COLUMN IF NOT EXISTS "carePackageId" UUID NULL`);
        await run(`ALTER TABLE ${prefix}"invoices" ADD COLUMN IF NOT EXISTS "carePackageId" UUID NULL`);
        await run(`ALTER TABLE ${prefix}"agenda_events"
            ADD COLUMN IF NOT EXISTS "carePackageId" UUID NULL,
            ADD COLUMN IF NOT EXISTS "packageReservationStatus" VARCHAR(16) NULL`);
        await run(`ALTER TABLE ${prefix}"package_consumptions"
            ADD COLUMN IF NOT EXISTS "type" VARCHAR(255) NOT NULL DEFAULT 'CONSUME',
            ADD COLUMN IF NOT EXISTS "reversalOfId" UUID NULL`);
        for (const [name, table, columns, unique] of [
            ['package_templates_structure_active_idx', 'package_templates', '"structureId", "isActive"', false],
            ['care_packages_purchase_key_unique', 'care_packages', '"idempotencyKey"', true],
            ['care_packages_structure_template_idx', 'care_packages', '"structureId", "templateId"', false],
            ['invoices_care_package_unique', 'invoices', '"carePackageId"', true],
            ['invoice_payments_package_status_idx', 'invoice_payments', '"carePackageId", "status"', false],
            ['agenda_events_package_reservation_idx', 'agenda_events', '"carePackageId", "packageReservationStatus"', false],
            ['package_consumptions_reversal_unique', 'package_consumptions', '"reversalOfId"', true]
        ]) await run(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${name}" ON ${prefix}"${table}" (${columns})`);
    },
    async down() { throw new Error('Package purchases and payment history must not be removed automatically.'); }
};

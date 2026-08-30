'use strict';

/**
 * Reporting foundations for every dynamic tenant schema.
 * The migration is deliberately idempotent so it can be resumed safely if one tenant fails.
 */
module.exports = {
    async up(queryInterface) {
        const [schemas] = await queryInterface.sequelize.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
        );

        for (const { schema_name: schema } of schemas) {
            await queryInterface.sequelize.transaction(async (transaction) => {
                const [tables] = await queryInterface.sequelize.query(
                    `SELECT
                        to_regclass('"${schema}"."agenda_events"') AS agenda_table,
                        to_regclass('"${schema}"."invoices"') AS invoices_table,
                        to_regclass('"${schema}"."patients"') AS patients_table`,
                    { transaction }
                );

                if (tables?.[0]?.agenda_table) {
                    await queryInterface.sequelize.query(
                        `ALTER TABLE "${schema}"."agenda_events" ADD COLUMN IF NOT EXISTS "patientId" UUID NULL`,
                        { transaction }
                    );
                    await queryInterface.sequelize.query(
                        `UPDATE "${schema}"."agenda_events"
                         SET "patientId" = ("patient"->>'id')::uuid
                         WHERE "patientId" IS NULL
                           AND "patient"->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
                        { transaction }
                    );
                    await queryInterface.sequelize.query(
                        `CREATE INDEX IF NOT EXISTS "agenda_events_structure_start_status_idx"
                            ON "${schema}"."agenda_events" ("structureId", "start", "status")`,
                        { transaction }
                    );
                    await queryInterface.sequelize.query(
                        `CREATE INDEX IF NOT EXISTS "agenda_events_calendar_start_status_idx"
                            ON "${schema}"."agenda_events" ("calendarId", "start", "status")`,
                        { transaction }
                    );
                    await queryInterface.sequelize.query(
                        `CREATE INDEX IF NOT EXISTS "agenda_events_patient_start_idx"
                            ON "${schema}"."agenda_events" ("patientId", "start")`,
                        { transaction }
                    );
                }

                if (tables?.[0]?.invoices_table) {
                    await queryInterface.sequelize.query(
                        `ALTER TABLE "${schema}"."invoices" ADD COLUMN IF NOT EXISTS "structureId" UUID NULL`,
                        { transaction }
                    );

                    if (tables?.[0]?.agenda_table) {
                        await queryInterface.sequelize.query(
                            `UPDATE "${schema}"."invoices" i
                             SET "structureId" = a."structureId"
                             FROM "${schema}"."agenda_events" a
                             WHERE i."structureId" IS NULL AND i."agendaEventId" = a."id"`,
                            { transaction }
                        );
                    }
                    if (tables?.[0]?.patients_table) {
                        await queryInterface.sequelize.query(
                            `UPDATE "${schema}"."invoices" i
                             SET "structureId" = p."structureId"
                             FROM "${schema}"."patients" p
                             WHERE i."structureId" IS NULL AND i."patientID" = p."id"`,
                            { transaction }
                        );
                    }

                    await queryInterface.sequelize.query(
                        `CREATE INDEX IF NOT EXISTS "invoices_structure_emission_idx"
                            ON "${schema}"."invoices" ("structureId", "emissionDate")`,
                        { transaction }
                    );
                    await queryInterface.sequelize.query(
                        `CREATE INDEX IF NOT EXISTS "invoices_structure_due_idx"
                            ON "${schema}"."invoices" ("structureId", "paymentTerms")`,
                        { transaction }
                    );

                    await queryInterface.sequelize.query(
                        `CREATE TABLE IF NOT EXISTS "${schema}"."invoice_payments" (
                            "id" UUID PRIMARY KEY,
                            "invoiceId" UUID NOT NULL,
                            "amount" DECIMAL(10,2) NOT NULL CHECK ("amount" > 0),
                            "paidAt" DATE NULL,
                            "method" VARCHAR(255) NULL,
                            "note" TEXT NULL,
                            "source" VARCHAR(24) NOT NULL DEFAULT 'USER',
                            "status" VARCHAR(16) NOT NULL DEFAULT 'POSTED',
                            "createdByUserId" UUID NULL,
                            "voidedAt" TIMESTAMPTZ NULL,
                            "voidedByUserId" UUID NULL,
                            "voidReason" TEXT NULL,
                            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                            "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
                        )`,
                        { transaction }
                    );
                    await queryInterface.sequelize.query(
                        `CREATE INDEX IF NOT EXISTS "invoice_payments_invoice_status_idx"
                            ON "${schema}"."invoice_payments" ("invoiceId", "status")`,
                        { transaction }
                    );
                    await queryInterface.sequelize.query(
                        `CREATE INDEX IF NOT EXISTS "invoice_payments_paid_at_idx"
                            ON "${schema}"."invoice_payments" ("paidAt")`,
                        { transaction }
                    );

                    // Preserve the old balance without inventing an unreliable payment date.
                    await queryInterface.sequelize.query(
                        `INSERT INTO "${schema}"."invoice_payments"
                            ("id", "invoiceId", "amount", "paidAt", "method", "source", "status", "createdAt", "updatedAt")
                         SELECT md5(i."id"::text || ':legacy-payment')::uuid,
                                i."id", i."invoiceTotal", NULL, i."paymentMethod",
                                'LEGACY_IMPORT', 'POSTED', NOW(), NOW()
                         FROM "${schema}"."invoices" i
                         WHERE LOWER(COALESCE(i."status", '')) = 'paid'
                           AND COALESCE(i."invoiceTotal", 0) > 0
                           AND NOT EXISTS (
                               SELECT 1 FROM "${schema}"."invoice_payments" p WHERE p."invoiceId" = i."id"
                           )`,
                        { transaction }
                    );
                }
            });
        }
    },

    async down(queryInterface) {
        const [schemas] = await queryInterface.sequelize.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
        );
        for (const { schema_name: schema } of schemas) {
            await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "${schema}"."invoice_payments"`);
            await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${schema}"."invoices_structure_due_idx"`);
            await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${schema}"."invoices_structure_emission_idx"`);
            await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${schema}"."agenda_events_patient_start_idx"`);
            await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${schema}"."agenda_events_calendar_start_status_idx"`);
            await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${schema}"."agenda_events_structure_start_status_idx"`);
            await queryInterface.sequelize.query(`ALTER TABLE "${schema}"."invoices" DROP COLUMN IF EXISTS "structureId"`);
            await queryInterface.sequelize.query(`ALTER TABLE "${schema}"."agenda_events" DROP COLUMN IF EXISTS "patientId"`);
        }
    }
};

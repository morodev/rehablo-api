'use strict';

/**
 * Rende esplicita e univoca la provenienza di una fattura da un appuntamento.
 *
 * Le fatture manuali mantengono `agendaEventId = NULL`; PostgreSQL permette piu' NULL in un
 * indice UNIQUE. Per i documenti gia' collegati, il backfill usa `agenda_events.invoiceId`, che
 * era la fonte di verita' prima dell'introduzione del riferimento inverso.
 */
module.exports = {
    async up(queryInterface) {
        const [schemas] = await queryInterface.sequelize.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
        );

        for (const { schema_name: schema } of schemas) {
            const [tables] = await queryInterface.sequelize.query(
                `SELECT
                    to_regclass('"${schema}"."invoices"') AS invoices_table,
                    to_regclass('"${schema}"."agenda_events"') AS agenda_table`
            );
            if (!tables?.[0]?.invoices_table) {
                continue;
            }

            await queryInterface.sequelize.query(
                `ALTER TABLE "${schema}"."invoices"
                 ADD COLUMN IF NOT EXISTS "agendaEventId" UUID NULL`
            );

            if (tables?.[0]?.agenda_table) {
                await queryInterface.sequelize.query(`
                    UPDATE "${schema}"."agenda_events"
                    SET "status" = 'COMPLETED', "erasable" = false
                    WHERE "invoiceId" IS NOT NULL
                `);

                await queryInterface.sequelize.query(`
                    UPDATE "${schema}"."invoices" i
                    SET "agendaEventId" = a."id"
                    FROM "${schema}"."agenda_events" a
                    WHERE a."invoiceId" = i."id"
                      AND i."agendaEventId" IS NULL
                `);

                await queryInterface.sequelize.query(`
                    CREATE UNIQUE INDEX IF NOT EXISTS "agenda_events_invoice_id_unique"
                        ON "${schema}"."agenda_events" ("invoiceId")
                        WHERE "invoiceId" IS NOT NULL
                `);
            }

            await queryInterface.sequelize.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS "invoices_agenda_event_id_unique"
                    ON "${schema}"."invoices" ("agendaEventId")
                    WHERE "agendaEventId" IS NOT NULL
            `);
        }
    },

    async down(queryInterface) {
        const [schemas] = await queryInterface.sequelize.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
        );

        for (const { schema_name: schema } of schemas) {
            const [tables] = await queryInterface.sequelize.query(
                `SELECT to_regclass('"${schema}"."invoices"') AS table_name`
            );
            if (!tables?.[0]?.table_name) {
                continue;
            }

            await queryInterface.sequelize.query(
                `DROP INDEX IF EXISTS "${schema}"."invoices_agenda_event_id_unique"`
            );
            await queryInterface.sequelize.query(
                `DROP INDEX IF EXISTS "${schema}"."agenda_events_invoice_id_unique"`
            );
            await queryInterface.sequelize.query(
                `ALTER TABLE "${schema}"."invoices" DROP COLUMN IF EXISTS "agendaEventId"`
            );
        }
    }
};

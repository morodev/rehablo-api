'use strict';

/**
 * Incassi operativi delle sedute, separati dai documenti fiscali ma trasferibili come
 * movimenti quando gli appuntamenti vengono successivamente inseriti in fattura.
 */
module.exports = {
    async up(queryInterface) {
        const [schemas] = await queryInterface.sequelize.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
        );

        for (const { schema_name: schema } of schemas) {
            const q = String.fromCharCode(34);
            const agendaTable = `${q}${schema}${q}.${q}agenda_events${q}`;
            const paymentsTable = `${q}${schema}${q}.${q}invoice_payments${q}`;
            const [tables] = await queryInterface.sequelize.query(
                `SELECT
                    to_regclass('${agendaTable}') AS agenda_table,
                    to_regclass('${paymentsTable}') AS payments_table`
            );

            await queryInterface.sequelize.transaction(async (transaction) => {
                if (tables?.[0]?.agenda_table) {
                    await queryInterface.sequelize.query(
                        `ALTER TABLE ${agendaTable}
                            ADD COLUMN IF NOT EXISTS ${q}appointmentPaymentStatus${q} VARCHAR(16) NULL DEFAULT 'unpaid',
                            ADD COLUMN IF NOT EXISTS ${q}appointmentPaidAmount${q} DECIMAL(10,2) NULL,
                            ADD COLUMN IF NOT EXISTS ${q}appointmentPaidAt${q} DATE NULL,
                            ADD COLUMN IF NOT EXISTS ${q}appointmentPaymentMethod${q} VARCHAR(255) NULL,
                            ADD COLUMN IF NOT EXISTS ${q}appointmentPaymentNote${q} TEXT NULL,
                            ADD COLUMN IF NOT EXISTS ${q}appointmentPaymentRecordedBy${q} UUID NULL`,
                        { transaction }
                    );
                    await queryInterface.sequelize.query(
                        `CREATE INDEX IF NOT EXISTS ${q}agenda_events_payment_status_idx${q}
                            ON ${agendaTable}
                            (${q}structureId${q}, ${q}appointmentPaymentStatus${q}, ${q}appointmentPaidAt${q})`,
                        { transaction }
                    );
                }

                if (tables?.[0]?.payments_table) {
                    await queryInterface.sequelize.query(
                        `ALTER TABLE ${paymentsTable}
                            ADD COLUMN IF NOT EXISTS ${q}agendaEventId${q} UUID NULL`,
                        { transaction }
                    );
                    await queryInterface.sequelize.query(
                        `CREATE UNIQUE INDEX IF NOT EXISTS ${q}invoice_payments_agenda_event_unique${q}
                            ON ${paymentsTable} (${q}agendaEventId${q})
                            WHERE ${q}agendaEventId${q} IS NOT NULL`,
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
            const q = String.fromCharCode(34);
            const agendaTable = `${q}${schema}${q}.${q}agenda_events${q}`;
            const paymentsTable = `${q}${schema}${q}.${q}invoice_payments${q}`;
            await queryInterface.sequelize.query(
                `DROP INDEX IF EXISTS ${q}${schema}${q}.${q}invoice_payments_agenda_event_unique${q}`
            );
            await queryInterface.sequelize.query(
                `ALTER TABLE IF EXISTS ${paymentsTable}
                    DROP COLUMN IF EXISTS ${q}agendaEventId${q}`
            );
            await queryInterface.sequelize.query(
                `DROP INDEX IF EXISTS ${q}${schema}${q}.${q}agenda_events_payment_status_idx${q}`
            );
            await queryInterface.sequelize.query(
                `ALTER TABLE IF EXISTS ${agendaTable}
                    DROP COLUMN IF EXISTS ${q}appointmentPaymentRecordedBy${q},
                    DROP COLUMN IF EXISTS ${q}appointmentPaymentNote${q},
                    DROP COLUMN IF EXISTS ${q}appointmentPaymentMethod${q},
                    DROP COLUMN IF EXISTS ${q}appointmentPaidAt${q},
                    DROP COLUMN IF EXISTS ${q}appointmentPaidAmount${q},
                    DROP COLUMN IF EXISTS ${q}appointmentPaymentStatus${q}`
            );
        }
    }
};

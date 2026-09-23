'use strict';

/**
 * Aggiunge lo snapshot del destinatario (`recipient`) alla tabella `invoices` di ogni schema tenant.
 *
 * Con la configurazione standard `TENANT_SCHEMA_SYNC=additive` la colonna viene creata
 * automaticamente dal model sync al primo avvio dopo il deploy (il bump della baseline del
 * modello tenant forza il sync sugli schemi esistenti). Questa migration copre anche le
 * installazioni che gestiscono lo schema manualmente con `TENANT_SCHEMA_SYNC=off`.
 *
 * La colonna è JSONB nullable: le fatture legacy restano senza snapshot e in stampa/invio
 * ricadono in modo dichiarato sui dati correnti del paziente.
 */
module.exports = {
    async up(queryInterface) {
        const [schemas] = await queryInterface.sequelize.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
        );

        for (const { schema_name: schema } of schemas) {
            await queryInterface.sequelize.query(
                `ALTER TABLE "${schema}"."invoices" ADD COLUMN IF NOT EXISTS "recipient" JSONB`
            );
        }
    },

    async down(queryInterface) {
        const [schemas] = await queryInterface.sequelize.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
        );

        for (const { schema_name: schema } of schemas) {
            await queryInterface.sequelize.query(
                `ALTER TABLE "${schema}"."invoices" DROP COLUMN IF EXISTS "recipient"`
            );
        }
    }
};

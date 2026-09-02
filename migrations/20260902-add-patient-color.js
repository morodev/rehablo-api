'use strict';

/**
 * Aggiunge il colore opzionale del paziente alla tabella `patients` di ogni schema tenant.
 *
 * La sincronizzazione additiva crea normalmente la colonna al primo accesso dopo il deploy.
 * La migration copre anche le installazioni che usano TENANT_SCHEMA_SYNC=off.
 */
module.exports = {
    async up(queryInterface) {
        const [schemas] = await queryInterface.sequelize.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
        );

        for (const { schema_name: schema } of schemas) {
            await queryInterface.sequelize.query(
                `ALTER TABLE "${schema}"."patients" ADD COLUMN IF NOT EXISTS "color" VARCHAR(32)`
            );
        }
    },

    async down(queryInterface) {
        const [schemas] = await queryInterface.sequelize.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
        );

        for (const { schema_name: schema } of schemas) {
            await queryInterface.sequelize.query(
                `ALTER TABLE "${schema}"."patients" DROP COLUMN IF EXISTS "color"`
            );
        }
    }
};

'use strict';

/**
 * Preferenze di contatto del paziente per le comunicazioni di servizio.
 *
 * Le colonne restano NULL di default e NULL significa "mai chiesto": le anagrafiche già
 * esistenti continuano quindi a ricevere la mail di conferma appuntamento come prima.
 * Solo un rifiuto esplicito (false) blocca l'invio.
 *
 * La sincronizzazione additiva crea normalmente le colonne al primo accesso dopo il deploy.
 * La migration copre anche le installazioni che usano TENANT_SCHEMA_SYNC=off.
 */
const COLUMNS = [
    ['emailNotificationsConsent', 'BOOLEAN'],
    ['whatsappNotificationsConsent', 'BOOLEAN'],
    ['communicationConsentDate', 'TIMESTAMP WITH TIME ZONE']
];

async function tenantSchemas(queryInterface) {
    const [schemas] = await queryInterface.sequelize.query(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
    );
    return schemas.map(({ schema_name: schema }) => schema);
}

module.exports = {
    async up(queryInterface) {
        for (const schema of await tenantSchemas(queryInterface)) {
            for (const [column, type] of COLUMNS) {
                await queryInterface.sequelize.query(
                    `ALTER TABLE "${schema}"."patients" ADD COLUMN IF NOT EXISTS "${column}" ${type}`
                );
            }
        }
    },

    async down(queryInterface) {
        for (const schema of await tenantSchemas(queryInterface)) {
            for (const [column] of COLUMNS) {
                await queryInterface.sequelize.query(
                    `ALTER TABLE "${schema}"."patients" DROP COLUMN IF EXISTS "${column}"`
                );
            }
        }
    }
};

'use strict';

/**
 * Aggiunge la colonna `isDefault` alla tabella `event_types` di OGNI schema tenant
 * (`rehablo_<tenantId>`): marca il tipo appuntamento proposto automaticamente quando si crea
 * un nuovo appuntamento in agenda.
 *
 * NOTA: in condizioni normali questa migration NON è necessaria, perché `ensureTenantSchema()`
 * (src/utils/tenantSchema.ts) sincronizza i modelli tenant-scoped in modalità additiva e aggiunge
 * la colonna al primo accesso al tenant dopo il deploy. Resta disponibile per applicare la
 * modifica in modo esplicito e controllato.
 *
 * L'unicità del predefinito (al massimo uno per tenant) è garantita a livello applicativo in
 * `eventType.controller.ts`, non da un vincolo: un indice univoco parziale bloccherebbe lo
 * scambio di predefinito, che passa fisiologicamente da uno stato con due righe a `true`
 * all'interno della stessa transazione.
 */
module.exports = {
    async up(queryInterface) {
        const [schemas] = await queryInterface.sequelize.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
        );

        for (const { schema_name: schema } of schemas) {
            await queryInterface.sequelize.query(
                `ALTER TABLE "${schema}"."event_types" ADD COLUMN IF NOT EXISTS "isDefault" BOOLEAN NOT NULL DEFAULT false`
            );
        }
    },

    async down(queryInterface) {
        const [schemas] = await queryInterface.sequelize.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
        );

        for (const { schema_name: schema } of schemas) {
            await queryInterface.sequelize.query(
                `ALTER TABLE "${schema}"."event_types" DROP COLUMN IF EXISTS "isDefault"`
            );
        }
    }
};


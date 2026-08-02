'use strict';

/**
 * Aggiunge la colonna `linkedServiceId` alla tabella `event_types` di OGNI schema tenant
 * (`rehablo_<tenantId>`), collegando un tipo appuntamento ad un servizio del catalogo.
 *
 * NOTA: in condizioni normali questa migration NON è necessaria, perché
 * `ensureTenantSchema()` (src/utils/tenantSchema.ts) esegue `sync({ alter: true })` su tutti i
 * modelli tenant-scoped e aggiunge la colonna al primo accesso al tenant dopo il deploy.
 * Questo script resta disponibile per applicare la modifica in modo esplicito/controllato.
 */
module.exports = {
  async up(queryInterface) {
    const [schemas] = await queryInterface.sequelize.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
    );

    for (const { schema_name: schema } of schemas) {
      await queryInterface.sequelize.query(
        `ALTER TABLE "${schema}"."event_types" ADD COLUMN IF NOT EXISTS "linkedServiceId" UUID NULL`
      );
    }
  },

  async down(queryInterface) {
    const [schemas] = await queryInterface.sequelize.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
    );

    for (const { schema_name: schema } of schemas) {
      await queryInterface.sequelize.query(
        `ALTER TABLE "${schema}"."event_types" DROP COLUMN IF EXISTS "linkedServiceId"`
      );
    }
  }
};


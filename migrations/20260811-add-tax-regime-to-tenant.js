'use strict';

/**
 * Introduce il REGIME FISCALE nei dati aziendali e i campi che ne derivano sui documenti.
 *
 * Perché serve una migration (a differenza di altre modifiche di schema):
 * `public.tenants` NON è una tabella tenant-scoped, quindi non passa da `ensureTenantSchema()`
 * (src/utils/tenantSchema.ts) e nessun `sync()` la allinea automaticamente al deploy.
 * Le colonne su `invoices`, invece, verrebbero aggiunte dal sync additivo: sono incluse qui
 * per poter applicare tutto in modo esplicito e controllato, ed è per questo che ogni ALTER usa
 * `IF NOT EXISTS` (rieseguirla è innocuo).
 *
 * Razionale fiscale completo: docs/REGIME_FISCALE_IT.md
 */

const TENANT_COLUMNS = [
    // Codice tabella `RegimeFiscale` FatturaPA (RF01-RF19). Default RF01 (ordinario): è la scelta
    // prudente perché applica l'IVA di riga e ammette la ritenuta, quindi non "nasconde" imposte
    // agli studi che non hanno ancora configurato il regime.
    ['taxRegime', 'VARCHAR(4)', `'RF01'`],
    // 'NONE' | 'INPS_GS' (rivalsa 4% Gestione Separata) | 'CASSA' (contributo integrativo).
    ['socialSecurityFund', 'VARCHAR(16)', `'NONE'`],
    ['socialSecurityRate', 'DECIMAL(5,2)', '4'],
    // Ritenuta d'acconto su redditi di lavoro autonomo: art. 25 DPR 600/1973.
    ['withholdingRate', 'DECIMAL(5,2)', '20'],
    // Imposta di bollo: DPR 642/1972, Tariffa Parte I art. 13.
    ['stampDutyAmount', 'DECIMAL(10,2)', '2'],
    // Riaddebito del bollo al paziente: escluso dalla base imponibile (art. 15 DPR 633/1972).
    ['stampChargedToPatient', 'BOOLEAN', 'true']
];

const INVOICE_COLUMNS = [
    ['stampChargedToPatient', 'BOOLEAN', 'false'],
    // Diciture obbligatorie congelate all'emissione, come già `issuer`.
    ['fiscalNotes', 'JSONB', 'NULL']
];

async function tenantSchemas(queryInterface) {
    const [schemas] = await queryInterface.sequelize.query(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
    );
    return schemas.map(({ schema_name: schema }) => schema);
}

module.exports = {
    async up(queryInterface) {
        for (const [name, type, defaultValue] of TENANT_COLUMNS) {
            await queryInterface.sequelize.query(
                `ALTER TABLE "public"."tenants" ADD COLUMN IF NOT EXISTS "${name}" ${type} DEFAULT ${defaultValue}`
            );
        }

        // I tenant già esistenti hanno la colonna a NULL solo se creata senza default in un
        // passaggio precedente: si allineano al default per non lasciare regimi "vuoti", che il
        // codice tratterebbe sì come RF01, ma senza che il dato sia visibile in Impostazioni.
        await queryInterface.sequelize.query(
            `UPDATE "public"."tenants" SET
                "taxRegime" = COALESCE("taxRegime", 'RF01'),
                "socialSecurityFund" = COALESCE("socialSecurityFund", 'NONE'),
                "socialSecurityRate" = COALESCE("socialSecurityRate", 4),
                "withholdingRate" = COALESCE("withholdingRate", 20),
                "stampDutyAmount" = COALESCE("stampDutyAmount", 2),
                "stampChargedToPatient" = COALESCE("stampChargedToPatient", true)`
        );

        for (const schema of await tenantSchemas(queryInterface)) {
            for (const [name, type, defaultValue] of INVOICE_COLUMNS) {
                await queryInterface.sequelize.query(
                    `ALTER TABLE "${schema}"."invoices" ADD COLUMN IF NOT EXISTS "${name}" ${type} DEFAULT ${defaultValue}`
                );
            }
        }
    },

    async down(queryInterface) {
        for (const [name] of TENANT_COLUMNS) {
            await queryInterface.sequelize.query(
                `ALTER TABLE "public"."tenants" DROP COLUMN IF EXISTS "${name}"`
            );
        }

        for (const schema of await tenantSchemas(queryInterface)) {
            for (const [name] of INVOICE_COLUMNS) {
                await queryInterface.sequelize.query(
                    `ALTER TABLE "${schema}"."invoices" DROP COLUMN IF EXISTS "${name}"`
                );
            }
        }
    }
};


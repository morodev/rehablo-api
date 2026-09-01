'use strict';

/**
 * Aggiunge i metadata del consenso privacy firmato alla tabella `patients` di ogni schema
 * tenant. Il file resta nello storage privato; nel database viene conservato soltanto il path
 * interno e i dati necessari a mostrarne lo stato.
 *
 * La sincronizzazione additiva crea normalmente queste colonne al primo accesso dopo il deploy.
 * La migration consente lo stesso aggiornamento nelle installazioni con TENANT_SCHEMA_SYNC=off.
 */
module.exports = {
    async up(queryInterface) {
        const [schemas] = await queryInterface.sequelize.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
        );

        for (const { schema_name: schema } of schemas) {
            await queryInterface.sequelize.query(
                `ALTER TABLE "${schema}"."patients"
                    ADD COLUMN IF NOT EXISTS "privacyDocumentStoragePath" VARCHAR(255),
                    ADD COLUMN IF NOT EXISTS "privacyDocumentOriginalName" VARCHAR(255),
                    ADD COLUMN IF NOT EXISTS "privacyDocumentMimeType" VARCHAR(255),
                    ADD COLUMN IF NOT EXISTS "privacyDocumentSizeBytes" INTEGER,
                    ADD COLUMN IF NOT EXISTS "privacyDocumentUploadedAt" TIMESTAMP WITH TIME ZONE,
                    ADD COLUMN IF NOT EXISTS "privacyDocumentUploadedBy" VARCHAR(255)`
            );
        }
    },

    async down(queryInterface) {
        const [schemas] = await queryInterface.sequelize.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
        );

        for (const { schema_name: schema } of schemas) {
            await queryInterface.sequelize.query(
                `ALTER TABLE "${schema}"."patients"
                    DROP COLUMN IF EXISTS "privacyDocumentUploadedBy",
                    DROP COLUMN IF EXISTS "privacyDocumentUploadedAt",
                    DROP COLUMN IF EXISTS "privacyDocumentSizeBytes",
                    DROP COLUMN IF EXISTS "privacyDocumentMimeType",
                    DROP COLUMN IF EXISTS "privacyDocumentOriginalName",
                    DROP COLUMN IF EXISTS "privacyDocumentStoragePath"`
            );
        }
    }
};

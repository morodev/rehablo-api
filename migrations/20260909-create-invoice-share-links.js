'use strict';

/**
 * Link di consegna della fattura al paziente.
 *
 * La tabella vive in `public` e non nello schema del tenant per una ragione precisa: il link viene
 * aperto da una richiesta anonima, che non ha un utente autenticato da cui derivare il tenant.
 * Il token è quindi la sola chiave di ricerca disponibile, e deve poter essere risolto prima di
 * sapere a quale centro appartiene la fattura.
 *
 * Come per gli inviti al portale, del token si conserva esclusivamente l'hash SHA-256: chi legge
 * il database non ottiene un link funzionante.
 */
module.exports = {
    async up(queryInterface) {
        await queryInterface.sequelize.query(`
            CREATE TABLE IF NOT EXISTS "invoice_share_links" (
                "id" UUID PRIMARY KEY,
                "tenantId" UUID NOT NULL REFERENCES "tenants" ("id") ON DELETE CASCADE,
                "invoiceId" UUID NOT NULL,
                "patientId" UUID NULL,
                "tokenHash" VARCHAR(64) NOT NULL,
                "createdByUserId" UUID NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
                "channel" VARCHAR(16) NOT NULL DEFAULT 'link'
                    CHECK ("channel" IN ('link', 'email', 'whatsapp')),
                "expiresAt" TIMESTAMPTZ NOT NULL,
                "revokedAt" TIMESTAMPTZ NULL,
                "lastViewedAt" TIMESTAMPTZ NULL,
                "viewCount" INTEGER NOT NULL DEFAULT 0,
                "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE UNIQUE INDEX IF NOT EXISTS "invoice_share_link_token_unique"
                ON "invoice_share_links" ("tokenHash");
            CREATE INDEX IF NOT EXISTS "invoice_share_link_invoice_idx"
                ON "invoice_share_links" ("tenantId", "invoiceId");
            CREATE INDEX IF NOT EXISTS "invoice_share_link_expiry_idx"
                ON "invoice_share_links" ("expiresAt");
        `);
    },

    async down(queryInterface) {
        await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "invoice_share_links"`);
    }
};

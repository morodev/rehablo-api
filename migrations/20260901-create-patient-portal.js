'use strict';

/**
 * Identita globale e portale paziente multi-centro.
 *
 * Le identita, gli inviti e i collegamenti alle cartelle locali vivono in public;
 * gli audit di consultazione restano invece nello schema del singolo tenant.
 */
module.exports = {
    async up(queryInterface) {
        await queryInterface.sequelize.transaction(async (transaction) => {
            await queryInterface.sequelize.query(`
                ALTER TABLE "tenant_users"
                    ADD COLUMN IF NOT EXISTS "deactivatedAt" TIMESTAMPTZ NULL;

                UPDATE "tenant_users" tu
                SET "deactivatedAt" = u."deactivatedAt"
                FROM "users" u
                WHERE u."id" = tu."userId"
                  AND u."deactivatedAt" IS NOT NULL
                  AND tu."deactivatedAt" IS NULL;

                -- Da questo momento la sospensione operativa e locale al tenant.
                UPDATE "users" SET "deactivatedAt" = NULL WHERE "deactivatedAt" IS NOT NULL;
            `, { transaction });

            await queryInterface.sequelize.query(`
                CREATE TABLE IF NOT EXISTS "user_emails" (
                    "id" UUID PRIMARY KEY,
                    "userId" UUID NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
                    "email" VARCHAR(255) NOT NULL,
                    "normalizedEmail" VARCHAR(255) NOT NULL,
                    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
                    "verifiedAt" TIMESTAMPTZ NULL,
                    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );

                CREATE UNIQUE INDEX IF NOT EXISTS "user_emails_normalized_unique"
                    ON "user_emails" ("normalizedEmail");
                CREATE INDEX IF NOT EXISTS "user_emails_user_id_idx"
                    ON "user_emails" ("userId");
                CREATE UNIQUE INDEX IF NOT EXISTS "user_emails_one_primary_per_user"
                    ON "user_emails" ("userId") WHERE "isPrimary" = true;

                INSERT INTO "user_emails" (
                    "id", "userId", "email", "normalizedEmail", "isPrimary", "verifiedAt", "createdAt", "updatedAt"
                )
                SELECT
                    md5(u."id"::text || ':primary-email')::uuid,
                    u."id",
                    u."email",
                    lower(btrim(u."email")),
                    true,
                    CASE WHEN u."isActive" THEN COALESCE(u."updatedAt", u."createdAt", NOW()) ELSE NULL END,
                    COALESCE(u."createdAt", NOW()),
                    COALESCE(u."updatedAt", u."createdAt", NOW())
                FROM "users" u
                WHERE btrim(u."email") <> ''
                ON CONFLICT ("normalizedEmail") DO NOTHING;
            `, { transaction });

            await queryInterface.sequelize.query(`
                CREATE TABLE IF NOT EXISTS "patient_portal_accesses" (
                    "id" UUID PRIMARY KEY,
                    "userId" UUID NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
                    "tenantId" UUID NOT NULL REFERENCES "tenants" ("id") ON DELETE CASCADE,
                    "patientId" UUID NOT NULL,
                    "relationship" VARCHAR(16) NOT NULL DEFAULT 'SELF'
                        CHECK ("relationship" IN ('SELF')),
                    "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
                        CHECK ("status" IN ('ACTIVE', 'HISTORICAL', 'REVOKED')),
                    "acceptedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    "historicalAt" TIMESTAMPTZ NULL,
                    "revokedAt" TIMESTAMPTZ NULL,
                    "revokedByUserId" UUID NULL REFERENCES "users" ("id") ON DELETE SET NULL,
                    "lastAccessAt" TIMESTAMPTZ NULL,
                    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );

                CREATE UNIQUE INDEX IF NOT EXISTS "patient_portal_access_self_unique"
                    ON "patient_portal_accesses" ("tenantId", "patientId", "relationship");
                CREATE INDEX IF NOT EXISTS "patient_portal_access_user_status_idx"
                    ON "patient_portal_accesses" ("userId", "status");

                CREATE TABLE IF NOT EXISTS "patient_portal_invitations" (
                    "id" UUID PRIMARY KEY,
                    "tenantId" UUID NOT NULL REFERENCES "tenants" ("id") ON DELETE CASCADE,
                    "patientId" UUID NOT NULL,
                    "email" VARCHAR(255) NOT NULL,
                    "normalizedEmail" VARCHAR(255) NOT NULL,
                    "tokenHash" VARCHAR(64) NOT NULL,
                    "invitedByUserId" UUID NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
                    "expiresAt" TIMESTAMPTZ NOT NULL,
                    "acceptedAt" TIMESTAMPTZ NULL,
                    "invalidatedAt" TIMESTAMPTZ NULL,
                    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );

                CREATE UNIQUE INDEX IF NOT EXISTS "patient_portal_invitation_token_unique"
                    ON "patient_portal_invitations" ("tokenHash");
                CREATE INDEX IF NOT EXISTS "patient_portal_invitation_patient_idx"
                    ON "patient_portal_invitations" ("tenantId", "patientId");
                CREATE INDEX IF NOT EXISTS "patient_portal_invitation_expiry_idx"
                    ON "patient_portal_invitations" ("expiresAt");

                ALTER TABLE "refresh_tokens"
                    ADD COLUMN IF NOT EXISTS "actor" VARCHAR(16) NOT NULL DEFAULT 'staff',
                    ADD COLUMN IF NOT EXISTS "patientAccessId" UUID NULL;

                CREATE INDEX IF NOT EXISTS "refresh_tokens_patient_access_idx"
                    ON "refresh_tokens" ("patientAccessId")
                    WHERE "patientAccessId" IS NOT NULL;
            `, { transaction });
        });

        const [schemas] = await queryInterface.sequelize.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
        );

        for (const { schema_name: schema } of schemas) {
            await queryInterface.sequelize.query(`
                CREATE TABLE IF NOT EXISTS "${schema}"."patient_portal_audit_logs" (
                    "id" UUID PRIMARY KEY,
                    "accessId" UUID NOT NULL,
                    "userId" UUID NOT NULL,
                    "patientId" UUID NOT NULL,
                    "action" VARCHAR(32) NOT NULL,
                    "resource" VARCHAR(48) NOT NULL,
                    "resourceId" UUID NULL,
                    "outcome" VARCHAR(16) NOT NULL CHECK ("outcome" IN ('SUCCESS', 'DENIED')),
                    "ipAddress" VARCHAR(45) NULL,
                    "userAgent" VARCHAR(255) NULL,
                    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );

                CREATE INDEX IF NOT EXISTS "patient_portal_audit_patient_created_idx"
                    ON "${schema}"."patient_portal_audit_logs" ("patientId", "createdAt");
                CREATE INDEX IF NOT EXISTS "patient_portal_audit_user_created_idx"
                    ON "${schema}"."patient_portal_audit_logs" ("userId", "createdAt");
            `);
        }
    },

    async down(queryInterface) {
        const [schemas] = await queryInterface.sequelize.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
        );
        for (const { schema_name: schema } of schemas) {
            await queryInterface.sequelize.query(
                `DROP TABLE IF EXISTS "${schema}"."patient_portal_audit_logs"`
            );
        }

        await queryInterface.sequelize.transaction(async (transaction) => {
            await queryInterface.sequelize.query(`
                DROP INDEX IF EXISTS "refresh_tokens_patient_access_idx";
                ALTER TABLE "refresh_tokens"
                    DROP COLUMN IF EXISTS "patientAccessId",
                    DROP COLUMN IF EXISTS "actor";

                DROP TABLE IF EXISTS "patient_portal_invitations";
                DROP TABLE IF EXISTS "patient_portal_accesses";
                DROP TABLE IF EXISTS "user_emails";

                UPDATE "users" u
                SET "deactivatedAt" = membership."deactivatedAt"
                FROM (
                    SELECT "userId", MIN("deactivatedAt") AS "deactivatedAt"
                    FROM "tenant_users"
                    WHERE "deactivatedAt" IS NOT NULL
                    GROUP BY "userId"
                ) membership
                WHERE u."id" = membership."userId";

                ALTER TABLE "tenant_users" DROP COLUMN IF EXISTS "deactivatedAt";
            `, { transaction });
        });
    }
};

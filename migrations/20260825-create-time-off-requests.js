'use strict';

/**
 * Crea il dominio ferie/permessi in ogni schema tenant e importa in modo idempotente
 * gli AgendaEvent legacy riconosciuti dai titoli "Ferie" e "Permesso".
 *
 * La migration non elimina né modifica gli eventi originali: il passaggio alla nuova
 * fonte dati viene effettuato dal frontend/backend solo dopo la verifica del backfill.
 */
module.exports = {
    async up(queryInterface) {
        const [schemas] = await queryInterface.sequelize.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
        );

        for (const { schema_name: schema } of schemas) {
            await queryInterface.sequelize.query(`
                CREATE TABLE IF NOT EXISTS "${schema}"."time_off_requests" (
                    "id" UUID PRIMARY KEY,
                    "structureId" UUID NULL,
                    "userId" UUID NOT NULL,
                    "type" VARCHAR(32) NOT NULL CHECK ("type" IN ('VACATION', 'PERMISSION', 'SICK_LEAVE', 'TRAINING', 'OTHER')),
                    "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'REVOKED')),
                    "start" TIMESTAMPTZ NOT NULL,
                    "end" TIMESTAMPTZ NOT NULL,
                    "allDay" BOOLEAN NOT NULL DEFAULT false,
                    "reason" TEXT NULL,
                    "requestedByUserId" UUID NOT NULL,
                    "reviewedByUserId" UUID NULL,
                    "reviewedAt" TIMESTAMPTZ NULL,
                    "reviewNote" TEXT NULL,
                    "legacyAgendaEventId" UUID NULL UNIQUE,
                    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);

            await queryInterface.sequelize.query(`
                CREATE TABLE IF NOT EXISTS "${schema}"."time_off_status_history" (
                    "id" UUID PRIMARY KEY,
                    "timeOffRequestId" UUID NOT NULL REFERENCES "${schema}"."time_off_requests" ("id") ON DELETE RESTRICT,
                    "fromStatus" VARCHAR(32) NULL CHECK ("fromStatus" IS NULL OR "fromStatus" IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'REVOKED')),
                    "toStatus" VARCHAR(32) NOT NULL CHECK ("toStatus" IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'REVOKED')),
                    "actorUserId" UUID NOT NULL,
                    "note" TEXT NULL,
                    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);

            await queryInterface.sequelize.query(`
                CREATE INDEX IF NOT EXISTS "time_off_requests_structure_period_idx"
                    ON "${schema}"."time_off_requests" ("structureId", "start", "end");
                CREATE INDEX IF NOT EXISTS "time_off_requests_user_period_idx"
                    ON "${schema}"."time_off_requests" ("userId", "start", "end");
                CREATE INDEX IF NOT EXISTS "time_off_requests_status_idx"
                    ON "${schema}"."time_off_requests" ("status");
                CREATE INDEX IF NOT EXISTS "time_off_history_request_created_idx"
                    ON "${schema}"."time_off_status_history" ("timeOffRequestId", "createdAt");
            `);

            const [agendaTable] = await queryInterface.sequelize.query(
                `SELECT to_regclass('"${schema}"."agenda_events"') AS table_name`
            );
            if (!agendaTable?.[0]?.table_name) {
                continue;
            }

            await queryInterface.sequelize.query(`
                INSERT INTO "${schema}"."time_off_requests" (
                    "id", "structureId", "userId", "type", "status", "start", "end", "allDay",
                    "reason", "requestedByUserId", "reviewedByUserId", "reviewedAt", "reviewNote",
                    "legacyAgendaEventId", "createdAt", "updatedAt"
                )
                SELECT
                    a."id",
                    a."structureId",
                    a."calendarId"::uuid,
                    CASE WHEN a."title" = 'Ferie' THEN 'VACATION' ELSE 'PERMISSION' END,
                    CASE WHEN a."status" = 'CANCELLED' THEN 'CANCELLED' ELSE 'APPROVED' END,
                    a."start"::timestamptz,
                    a."end"::timestamptz,
                    COALESCE(a."allDay", false),
                    NULLIF(a."description", ''),
                    a."calendarId"::uuid,
                    CASE WHEN a."status" = 'CANCELLED' THEN NULL ELSE a."calendarId"::uuid END,
                    CASE WHEN a."status" = 'CANCELLED' THEN NULL ELSE COALESCE(a."updatedAt", a."createdAt", NOW()) END,
                    'Migrata automaticamente da AgendaEvent',
                    a."id",
                    COALESCE(a."createdAt", NOW()),
                    COALESCE(a."updatedAt", a."createdAt", NOW())
                FROM "${schema}"."agenda_events" a
                WHERE a."title" IN ('Ferie', 'Permesso')
                  AND (a."patient" IS NULL OR a."patient"::text IN ('null', '{}', '""'))
                  AND a."calendarId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  AND a."start" IS NOT NULL
                  AND a."end" IS NOT NULL
                ON CONFLICT ("legacyAgendaEventId") DO NOTHING
            `);

            // Anche i record importati entrano nello storico: l'id dell'assenza è
            // riutilizzabile perché la PK appartiene a una tabella distinta.
            await queryInterface.sequelize.query(`
                INSERT INTO "${schema}"."time_off_status_history" (
                    "id", "timeOffRequestId", "fromStatus", "toStatus",
                    "actorUserId", "note", "createdAt"
                )
                SELECT
                    t."id",
                    t."id",
                    NULL,
                    t."status",
                    t."requestedByUserId",
                    'Migrata automaticamente da AgendaEvent',
                    t."createdAt"
                FROM "${schema}"."time_off_requests" t
                WHERE t."legacyAgendaEventId" IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1
                      FROM "${schema}"."time_off_status_history" h
                      WHERE h."timeOffRequestId" = t."id"
                  )
                ON CONFLICT ("id") DO NOTHING
            `);
        }
    },

    async down(queryInterface) {
        const [schemas] = await queryInterface.sequelize.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
        );

        for (const { schema_name: schema } of schemas) {
            await queryInterface.sequelize.query(
                `DROP TABLE IF EXISTS "${schema}"."time_off_status_history"`
            );
            await queryInterface.sequelize.query(
                `DROP TABLE IF EXISTS "${schema}"."time_off_requests"`
            );
        }
    }
};

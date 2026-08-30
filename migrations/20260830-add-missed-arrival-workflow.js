'use strict';

/**
 * Persiste la segnalazione di mancato arrivo e la successiva decisione operativa/economica.
 * La migrazione attraversa tutti gli schemi tenant ed e' idempotente, come le altre
 * migrazioni multi-tenant del progetto.
 */
module.exports = {
    async up(queryInterface) {
        const [schemas] = await queryInterface.sequelize.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
        );

        for (const { schema_name: schema } of schemas) {
            const [tables] = await queryInterface.sequelize.query(
                `SELECT to_regclass('"${schema}"."agenda_events"') AS table_name`
            );
            if (!tables?.[0]?.table_name) continue;

            await queryInterface.sequelize.transaction(async (transaction) => {
                await queryInterface.sequelize.query(
                    `ALTER TABLE "${schema}"."agenda_events"
                        ADD COLUMN IF NOT EXISTS "missedArrivalReportedAt" TIMESTAMPTZ NULL,
                        ADD COLUMN IF NOT EXISTS "missedArrivalReportedBy" UUID NULL,
                        ADD COLUMN IF NOT EXISTS "missedArrivalResolvedAt" TIMESTAMPTZ NULL,
                        ADD COLUMN IF NOT EXISTS "missedArrivalResolvedBy" UUID NULL,
                        ADD COLUMN IF NOT EXISTS "missedArrivalResolution" VARCHAR(24) NULL,
                        ADD COLUMN IF NOT EXISTS "noShowBillingDecision" VARCHAR(16) NULL`,
                    { transaction }
                );
                await queryInterface.sequelize.query(
                    `CREATE INDEX IF NOT EXISTS "agenda_events_missed_arrival_idx"
                        ON "${schema}"."agenda_events"
                        ("structureId", "missedArrivalReportedAt", "missedArrivalResolvedAt")`,
                    { transaction }
                );
            });
        }
    },

    async down(queryInterface) {
        const [schemas] = await queryInterface.sequelize.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'`
        );

        for (const { schema_name: schema } of schemas) {
            const [tables] = await queryInterface.sequelize.query(
                `SELECT to_regclass('"${schema}"."agenda_events"') AS table_name`
            );
            if (!tables?.[0]?.table_name) continue;

            await queryInterface.sequelize.query(
                `DROP INDEX IF EXISTS "${schema}"."agenda_events_missed_arrival_idx"`
            );
            await queryInterface.sequelize.query(
                `ALTER TABLE "${schema}"."agenda_events"
                    DROP COLUMN IF EXISTS "noShowBillingDecision",
                    DROP COLUMN IF EXISTS "missedArrivalResolution",
                    DROP COLUMN IF EXISTS "missedArrivalResolvedBy",
                    DROP COLUMN IF EXISTS "missedArrivalResolvedAt",
                    DROP COLUMN IF EXISTS "missedArrivalReportedBy",
                    DROP COLUMN IF EXISTS "missedArrivalReportedAt"`
            );
        }
    }
};

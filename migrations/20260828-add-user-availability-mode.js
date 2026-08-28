'use strict';

/**
 * Distingue gli operatori che seguono dinamicamente l'apertura della sede da quelli
 * con un orario personale. Le disponibilitÃ  preesistenti non vengono perse: se esiste
 * almeno un giorno abilitato, l'utente viene classificato come CUSTOM.
 */
module.exports = {
    async up(queryInterface) {
        await queryInterface.sequelize.query(`
            ALTER TABLE "public"."users"
            ADD COLUMN IF NOT EXISTS "availabilityMode" VARCHAR(32)
        `);

        await queryInterface.sequelize.query(`
            UPDATE "public"."users" u
            SET "availabilityMode" = CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM "public"."user_availabilities" a
                    WHERE a."userId" = u."id" AND COALESCE(a."enabled", false) = true
                ) THEN 'CUSTOM'
                ELSE 'INHERIT_STRUCTURE'
            END
            WHERE u."availabilityMode" IS NULL
        `);

        await queryInterface.sequelize.query(`
            ALTER TABLE "public"."users"
            ALTER COLUMN "availabilityMode" SET DEFAULT 'INHERIT_STRUCTURE',
            ALTER COLUMN "availabilityMode" SET NOT NULL
        `);

        await queryInterface.sequelize.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'users_availability_mode_check'
                      AND conrelid = 'public.users'::regclass
                ) THEN
                    ALTER TABLE "public"."users"
                    ADD CONSTRAINT "users_availability_mode_check"
                    CHECK ("availabilityMode" IN ('INHERIT_STRUCTURE', 'CUSTOM'));
                END IF;
            END $$
        `);
    },

    async down(queryInterface) {
        await queryInterface.sequelize.query(`
            ALTER TABLE "public"."users"
            DROP CONSTRAINT IF EXISTS "users_availability_mode_check",
            DROP COLUMN IF EXISTS "availabilityMode"
        `);
    }
};


'use strict';

const quote = value => '"' + String(value).replaceAll('"', '""') + '"';

function validateSchema(schema) {
    if (typeof schema !== 'string' || !/^rehablo_[a-f0-9]{32}$/i.test(schema)) {
        throw new Error('Invalid tenant schema');
    }
}

module.exports = {
    async up(queryInterface, options = {}) {
        const schema = options.schema;
        validateSchema(schema);
        const prefix = quote(schema) + '.';
        const run = (sql, replacements = {}) => queryInterface.sequelize.query(sql, {
            transaction: options.transaction,
            replacements
        });

        await run(`ALTER TABLE ${prefix}"reminders"
            ADD COLUMN IF NOT EXISTS "dueAllDay" BOOLEAN NOT NULL DEFAULT false`);
        await run(`ALTER TABLE ${prefix}"note_images"
            ADD COLUMN IF NOT EXISTS "noteId" UUID NULL`);

        await run(`CREATE TABLE IF NOT EXISTS ${prefix}"note_assignments" (
            "noteId" UUID NOT NULL REFERENCES ${prefix}"notes" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
            "userId" UUID NOT NULL,
            "assignedByUserId" UUID NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY ("noteId", "userId")
        )`);
        await run(`CREATE INDEX IF NOT EXISTS "note_assignments_user_id"
            ON ${prefix}"note_assignments" ("userId")`);

        await run(`CREATE TABLE IF NOT EXISTS ${prefix}"reminder_assignments" (
            "reminderId" UUID NOT NULL REFERENCES ${prefix}"reminders" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
            "userId" UUID NOT NULL,
            "assignedByUserId" UUID NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY ("reminderId", "userId")
        )`);
        await run(`CREATE INDEX IF NOT EXISTS "reminder_assignments_user_id"
            ON ${prefix}"reminder_assignments" ("userId")`);

        await run(`CREATE TABLE IF NOT EXISTS ${prefix}"reminder_alert_states" (
            "reminderId" UUID NOT NULL REFERENCES ${prefix}"reminders" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
            "userId" UUID NOT NULL,
            "scheduledFor" TIMESTAMPTZ NULL,
            "deliveredAt" TIMESTAMPTZ NULL,
            "snoozedUntil" TIMESTAMPTZ NULL,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY ("reminderId", "userId")
        )`);
        await run(`CREATE INDEX IF NOT EXISTS "reminder_alert_states_due"
            ON ${prefix}"reminder_alert_states" ("userId", "snoozedUntil")`);

        await run(`INSERT INTO ${prefix}"note_assignments"
            ("noteId", "userId", "assignedByUserId", "createdAt", "updatedAt")
            SELECT "id", "ownerUserId", "createdByUserId", NOW(), NOW()
            FROM ${prefix}"notes"
            WHERE "deletedAt" IS NULL
            ON CONFLICT ("noteId", "userId") DO NOTHING`);
        await run(`INSERT INTO ${prefix}"reminder_assignments"
            ("reminderId", "userId", "assignedByUserId", "createdAt", "updatedAt")
            SELECT "id", "assigneeUserId", "createdByUserId", NOW(), NOW()
            FROM ${prefix}"reminders"
            WHERE "deletedAt" IS NULL
            ON CONFLICT ("reminderId", "userId") DO NOTHING`);

        await run(`UPDATE ${prefix}"note_images" image
            SET "noteId" = note."id", "updatedAt" = NOW()
            FROM ${prefix}"notes" note
            WHERE image."noteId" IS NULL
              AND note."deletedAt" IS NULL
              AND note."contentHtml" LIKE ('%' || image."id"::text || '%')`);
        await run(`CREATE INDEX IF NOT EXISTS "note_images_note_id"
            ON ${prefix}"note_images" ("noteId")`);
    },

    async down() {
        throw new Error('Work item assignments cannot be removed automatically.');
    }
};

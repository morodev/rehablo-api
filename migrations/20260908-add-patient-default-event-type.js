'use strict';

const VERSIONED_CONSTRAINT = 'patients_default_event_type_fk';

function validateSchema(schema) {
    if (typeof schema !== 'string' || !/^rehablo_[a-f0-9]{32}$/i.test(schema)) {
        throw new Error('Invalid tenant schema: expected rehablo_ followed by a UUID without hyphens.');
    }
}

const quote = value => '"' + String(value).replaceAll('"', '""') + '"';

module.exports = {
    async up(queryInterface, options = {}) {
        const schema = options.schema;
        validateSchema(schema);
        const prefix = quote(schema) + '.';
        const patients = prefix + '"patients"';
        const eventTypes = prefix + '"event_types"';
        const run = sql => queryInterface.sequelize.query(sql, { transaction: options.transaction });

        const [tables] = await queryInterface.sequelize.query(
            'SELECT to_regclass(:patients) AS patients, to_regclass(:eventTypes) AS "eventTypes"',
            { replacements: { patients, eventTypes }, transaction: options.transaction }
        );
        if (!tables[0]?.patients || !tables[0]?.eventTypes) {
            throw new Error('Patient/event type prerequisites are missing in the selected tenant.');
        }

        await run(`ALTER TABLE ${patients} ADD COLUMN IF NOT EXISTS "defaultEventTypeId" UUID NULL`);
        await run(`CREATE INDEX IF NOT EXISTS "patients_default_event_type_idx" ON ${patients} ("defaultEventTypeId")`);

        const [constraints] = await queryInterface.sequelize.query(`
            SELECT 1 FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = :schema AND t.relname = 'patients' AND c.conname = :constraint`, {
            replacements: { schema, constraint: VERSIONED_CONSTRAINT },
            transaction: options.transaction
        });
        if (!constraints.length) {
            await run(`ALTER TABLE ${patients}
                ADD CONSTRAINT ${quote(VERSIONED_CONSTRAINT)}
                FOREIGN KEY ("defaultEventTypeId") REFERENCES ${eventTypes} ("id")
                ON UPDATE CASCADE ON DELETE SET NULL`);
        }
    },

    async down(queryInterface, options = {}) {
        const schema = options.schema;
        validateSchema(schema);
        const prefix = quote(schema) + '.';
        const patients = prefix + '"patients"';
        const run = sql => queryInterface.sequelize.query(sql, { transaction: options.transaction });

        await run(`ALTER TABLE ${patients} DROP CONSTRAINT IF EXISTS ${quote(VERSIONED_CONSTRAINT)}`);
        await run(`DROP INDEX IF EXISTS ${prefix}"patients_default_event_type_idx"`);
        await run(`ALTER TABLE ${patients} DROP COLUMN IF EXISTS "defaultEventTypeId"`);
    }
};

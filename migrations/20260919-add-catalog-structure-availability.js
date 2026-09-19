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
            transaction: options.transaction, replacements
        });

        for (const table of ['products', 'services', 'event_types']) {
            await run(`ALTER TABLE ${prefix}${quote(table)} ADD COLUMN IF NOT EXISTS "availabilityMode" VARCHAR(16) NOT NULL DEFAULT 'ALL'`);
            await run(`UPDATE ${prefix}${quote(table)} SET "availabilityMode" = 'ALL' WHERE "availabilityMode" IS NULL`);
        }

        await run(`CREATE TABLE IF NOT EXISTS ${prefix}"product_structures" (
            "productId" UUID NOT NULL REFERENCES ${prefix}"products" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
            "structureId" UUID NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY ("productId", "structureId")
        )`);
        await run(`CREATE INDEX IF NOT EXISTS "product_structures_structure_id" ON ${prefix}"product_structures" ("structureId")`);

        await run(`CREATE TABLE IF NOT EXISTS ${prefix}"service_structures" (
            "serviceId" UUID NOT NULL REFERENCES ${prefix}"services" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
            "structureId" UUID NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY ("serviceId", "structureId")
        )`);
        await run(`CREATE INDEX IF NOT EXISTS "service_structures_structure_id" ON ${prefix}"service_structures" ("structureId")`);

        await run(`CREATE TABLE IF NOT EXISTS ${prefix}"event_type_structures" (
            "eventTypeId" UUID NOT NULL REFERENCES ${prefix}"event_types" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
            "structureId" UUID NOT NULL,
            "isDefault" BOOLEAN NOT NULL DEFAULT false,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY ("eventTypeId", "structureId")
        )`);
        await run(`CREATE INDEX IF NOT EXISTS "event_type_structures_structure_id" ON ${prefix}"event_type_structures" ("structureId")`);
        await run(`CREATE UNIQUE INDEX IF NOT EXISTS "event_type_structures_one_default_per_structure"
            ON ${prefix}"event_type_structures" ("structureId") WHERE "isDefault" = true`);

        const tenantHex = schema.slice('rehablo_'.length);
        const tenantId = `${tenantHex.slice(0, 8)}-${tenantHex.slice(8, 12)}-${tenantHex.slice(12, 16)}-${tenantHex.slice(16, 20)}-${tenantHex.slice(20)}`;
        await run(`INSERT INTO ${prefix}"event_type_structures" ("eventTypeId", "structureId", "isDefault", "createdAt", "updatedAt")
            SELECT event_type."id", structure."id", true, NOW(), NOW()
            FROM (
                SELECT "id" FROM ${prefix}"event_types"
                WHERE "isDefault" = true
                ORDER BY "updatedAt" DESC, "id" ASC
                LIMIT 1
            ) event_type
            CROSS JOIN public."structures" structure
            WHERE structure."tenantId" = :tenantId
            ON CONFLICT ("eventTypeId", "structureId") DO UPDATE SET "isDefault" = true, "updatedAt" = NOW()`, {tenantId});
    },

    async down() {
        throw new Error('Catalog structure availability cannot be removed automatically.');
    }
};

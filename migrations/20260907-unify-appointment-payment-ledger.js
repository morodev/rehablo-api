'use strict';

/**
 * Run after the existing invoice/payment migrations, before enabling the new application.
 * Per-tenant transaction; repeatable imports preserve unknown dates and VOID corrections.
 * No tariff history is invented. Historical full-payment amounts alone can freeze a gross price.
 */
module.exports = {
    async up(queryInterface, options = {}) {
        const selectedSchema = options.schema;
        if (options.transaction && !selectedSchema) throw new Error('A transaction requires one selected tenant schema.');
        if (selectedSchema !== undefined && (typeof selectedSchema !== 'string' || !/^rehablo_[a-f0-9]{32}$/i.test(selectedSchema))) {
            throw new Error('Invalid tenant schema: expected rehablo_ followed by a UUID without hyphens.');
        }
        const [schemas] = await queryInterface.sequelize.query(
            selectedSchema
                ? 'SELECT schema_name FROM information_schema.schemata WHERE schema_name = :schema'
                : "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rehablo\\_%'",
            selectedSchema ? { replacements: { schema: selectedSchema }, transaction: options.transaction } : {}
        );
        if (selectedSchema && schemas.length !== 1) throw new Error('Selected tenant schema does not exist.');
        const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
        for (const { schema_name: schema } of schemas) {
            const prefix = quote(schema) + '.';
            const agenda = prefix + '"agenda_events"';
            const payments = prefix + '"invoice_payments"';
            const links = prefix + '"invoice_agenda_events"';
            const invoices = prefix + '"invoices"';
            const [tables] = await queryInterface.sequelize.query(
                'SELECT to_regclass(:agenda) AS agenda, to_regclass(:payments) AS payments, to_regclass(:invoices) AS invoices',
                { replacements: { agenda, payments, invoices }, transaction: options.transaction }
            );
            if (!tables[0]?.agenda || !tables[0]?.payments || !tables[0]?.invoices) {
                if (selectedSchema) throw new Error('Existing agenda/payment prerequisites are missing in the selected tenant.');
                continue;
            }
            const migrate = async transaction => {
                const run = sql => queryInterface.sequelize.query(sql, { transaction });
                await run("SET LOCAL lock_timeout = '10s'");
                // Classify the pre-migration state only after blocking competing writes.
                await run(`LOCK TABLE ${agenda}, ${payments}, ${invoices} IN ACCESS EXCLUSIVE MODE`);
                const [previousColumns] = await queryInterface.sequelize.query(
                    "SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = :schema AND table_name IN ('agenda_events', 'invoice_payments')",
                    { transaction, replacements: { schema } }
                );
                const historyWasAdded = previousColumns.some(column => column.table_name === 'agenda_events'
                    && column.column_name === 'appointmentPaymentHistoryKnown');
                const invoiceWasRequired = previousColumns.some(column => column.table_name === 'invoice_payments'
                    && column.column_name === 'invoiceId' && column.is_nullable === 'NO');
                await run(`ALTER TABLE ${agenda}
                    ADD COLUMN IF NOT EXISTS "appointmentExpectedAmount" DECIMAL(10,2) NULL,
                    ADD COLUMN IF NOT EXISTS "appointmentNetAmount" DECIMAL(10,2) NULL,
                    ADD COLUMN IF NOT EXISTS "appointmentVatRate" DECIMAL(5,2) NULL,
                    ADD COLUMN IF NOT EXISTS "appointmentPriceRecordedAt" TIMESTAMPTZ NULL,
                    ADD COLUMN IF NOT EXISTS "appointmentPaymentHistoryKnown" BOOLEAN NOT NULL DEFAULT false`);
                await run(`ALTER TABLE ${agenda} ALTER COLUMN "appointmentPaymentHistoryKnown" SET DEFAULT true`);
                await run(`ALTER TABLE ${payments} ALTER COLUMN "invoiceId" DROP NOT NULL`);
                await run(`CREATE TABLE IF NOT EXISTS ${links} (
                    "id" UUID PRIMARY KEY, "invoiceId" UUID NOT NULL, "agendaEventId" UUID NOT NULL,
                    "serviceId" UUID NULL, "releasedAt" TIMESTAMPTZ NULL,
                    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )`);
                await run(`ALTER TABLE ${links} ADD COLUMN IF NOT EXISTS "releasedAt" TIMESTAMPTZ NULL`);
                if (historyWasAdded && (invoiceWasRequired || options.repairHistoryKnown === true)) {
                    // Additive model sync may have populated true on old records before this migration.
                    // Reset only this not-yet-enabled rollout state. Reruns after nullable invoiceId
                    // preserve newly created known records even when they have no price or payment.
                    await run(`UPDATE ${agenda} a SET "appointmentPaymentHistoryKnown" = false
                        WHERE a."appointmentPaymentHistoryKnown" = true
                            AND a."appointmentPriceRecordedAt" IS NULL
                            AND a."appointmentPaymentRecordedBy" IS NULL
                            AND NOT (COALESCE(a."appointmentPaidAmount", 0) > 0
                                AND COALESCE(a."appointmentPaymentStatus", '') IN ('paid', 'partial'))
                            AND NOT EXISTS (SELECT 1 FROM ${payments} p WHERE p."agendaEventId" = a."id")`);
                }
                // Remove UNIQUE constraints and their backing indexes, including auto-sync generated names.
                for (const table of ['invoice_payments', 'invoice_agenda_events']) {
                    const [constraints] = await queryInterface.sequelize.query(`
                        SELECT c.conname FROM pg_constraint c
                        JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
                        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = 'agendaEventId'
                        WHERE n.nspname = :schema AND t.relname = :table AND c.contype = 'u'
                          AND c.conkey = ARRAY[a.attnum]::smallint[]`,
                    { transaction, replacements: { schema, table } });
                    for (const row of constraints) await run(`ALTER TABLE ${prefix}${quote(table)} DROP CONSTRAINT ${quote(row.conname)}`);
                    const [indexes] = await queryInterface.sequelize.query(`
                        SELECT idx.relname AS index_name FROM pg_index i
                        JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
                        JOIN pg_class idx ON idx.oid = i.indexrelid
                        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = 'agendaEventId'
                        WHERE n.nspname = :schema AND t.relname = :table AND i.indisunique
                            AND i.indnkeyatts = 1 AND a.attnum = i.indkey[0]
                            AND idx.relname <> 'invoice_agenda_events_active_event_unique'`,
                    { transaction, replacements: { schema, table } });
                    for (const row of indexes) await run(`DROP INDEX ${prefix}${quote(row.index_name)}`);
                }
                await run(`DROP INDEX IF EXISTS ${prefix}"invoice_payments_agenda_event_unique"`);
                await run(`DROP INDEX IF EXISTS ${prefix}"invoice_agenda_events_agenda_event_id_unique"`);
                await run(`CREATE INDEX IF NOT EXISTS "invoice_payments_agenda_event_status_idx" ON ${payments} ("agendaEventId", "status")`);
                await run(`CREATE UNIQUE INDEX IF NOT EXISTS "invoice_agenda_events_active_event_unique" ON ${links} ("agendaEventId") WHERE "releasedAt" IS NULL`);
                await run(`CREATE INDEX IF NOT EXISTS "invoice_agenda_events_invoice_id_idx" ON ${links} ("invoiceId")`);

                await run(`INSERT INTO ${payments}
                    ("id", "invoiceId", "agendaEventId", "amount", "paidAt", "method", "note", "source", "status", "createdByUserId", "createdAt", "updatedAt")
                    SELECT md5(a."id"::text || ':appointment-payment')::uuid, NULL, a."id",
                        a."appointmentPaidAmount", a."appointmentPaidAt", a."appointmentPaymentMethod", a."appointmentPaymentNote",
                        'APPOINTMENT', 'POSTED', a."appointmentPaymentRecordedBy", NOW(), NOW()
                    FROM ${agenda} a
                    WHERE a."invoiceId" IS NULL AND COALESCE(a."appointmentPaidAmount", 0) > 0
                        AND a."appointmentPaymentStatus" IN ('paid', 'partial')
                        AND NOT EXISTS (SELECT 1 FROM ${links} l WHERE l."agendaEventId" = a."id" AND l."releasedAt" IS NULL)
                        AND NOT EXISTS (SELECT 1 FROM ${invoices} i WHERE i."agendaEventId" = a."id" AND LOWER(COALESCE(i."status", '')) <> 'void')
                        AND NOT EXISTS (SELECT 1 FROM ${payments} p WHERE p."agendaEventId" = a."id")
                    ON CONFLICT ("id") DO NOTHING`);
                await run(`UPDATE ${agenda} a SET
                    "appointmentExpectedAmount" = a."appointmentPaidAmount",
                    "appointmentPriceRecordedAt" = NOW()
                    WHERE a."appointmentExpectedAmount" IS NULL AND a."appointmentPaymentStatus" = 'paid'
                        AND COALESCE(a."appointmentPaidAmount", 0) > 0`);
                await run(`UPDATE ${agenda} a SET "appointmentPaymentHistoryKnown" = true
                    WHERE a."appointmentPriceRecordedAt" IS NOT NULL OR a."appointmentPaymentRecordedBy" IS NOT NULL
                        OR EXISTS (SELECT 1 FROM ${payments} p WHERE p."agendaEventId" = a."id")`);
            };
            if (options.transaction) await migrate(options.transaction);
            else await queryInterface.sequelize.transaction(migrate);
        }
    },
    async down() {
        throw new Error('This migration preserves payment history and cannot be rolled back by dropping columns. Restore a reviewed backup or deploy a forward migration.');
    }
};

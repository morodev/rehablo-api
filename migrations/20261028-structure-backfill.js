// Immutable per-tenant structure backfill; always uses the supplied transaction/connection.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runStructureBackfillTenant = runStructureBackfillTenant;
const sequelize_1 = require("sequelize");
const getTenantSchemaName = (tenantId) => 'rehablo_' + tenantId.replaceAll('-', '');
const TABLES = ['patients', 'evaluations', 'agenda_events', 'notes', 'reminders', 'time_off_requests'];
function createBackfillWorker(database, transaction) {
    async function schemaExists(schema) {
        const rows = await database.query(`SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = :schema) AS exists`, { replacements: { schema }, type: sequelize_1.QueryTypes.SELECT, transaction });
        return !!rows[0]?.exists;
    }
    async function tableExists(schema, table) {
        const rows = await database.query(`SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                 WHERE table_schema = :schema AND table_name = :table
             ) AS exists`, { replacements: { schema, table }, type: sequelize_1.QueryTypes.SELECT, transaction });
        return !!rows[0]?.exists;
    }
    async function countNull(schema, table) {
        const rows = await database.query(`SELECT COUNT(*) AS count FROM "${schema}"."${table}" WHERE "structureId" IS NULL`, { type: sequelize_1.QueryTypes.SELECT, transaction });
        return parseInt(rows[0]?.count ?? '0', 10);
    }
    /** In dry-run conta le righe che verrebbero toccate, senza scrivere. */
    async function execute(apply, updateSql, countSql, replacements) {
        if (!apply) {
            const rows = await database.query(countSql, {
                replacements,
                type: sequelize_1.QueryTypes.SELECT, transaction
            });
            return parseInt(rows[0]?.count ?? '0', 10);
        }
        const [, affected] = await database.query(updateSql, { replacements, type: sequelize_1.QueryTypes.UPDATE, transaction });
        return affected ?? 0;
    }
    /** Sedi del tenant a cui un utente è assegnato, quando è assegnato a UNA sola. */
    const singleStructurePerUser = (cast) => `
        SELECT su."userId"${cast} AS user_id, MIN(su."structureId"::text)::uuid AS structure_id
          FROM public.structure_users su
          JOIN public.structures s ON s.id = su."structureId"
         WHERE s."tenantId" = :tenantId
      GROUP BY su."userId"
        HAVING COUNT(*) = 1
    `;
    async function backfillTenant(tenant, apply, report, verbose) {
        const schema = getTenantSchemaName(tenant.id);
        const label = tenant.businessName || tenant.id;
        // Gli schemi tenant sono creati lazy: se non esiste, non c'è nulla da migrare.
        if (!(await schemaExists(schema)))
            return;
        const structures = await database.query(`SELECT id FROM public.structures WHERE "tenantId" = :tenantId`, { replacements: { tenantId: tenant.id }, type: sequelize_1.QueryTypes.SELECT, transaction });
        if (structures.length === 0)
            return;
        const single = structures.length === 1 ? structures[0].id : null;
        const add = (key, value) => {
            if (value > 0)
                report.updated[key] = (report.updated[key] ?? 0) + value;
        };
        // --- Pazienti ---
        if (await tableExists(schema, 'patients')) {
            let updated = 0;
            if (!single) {
                // Prima del creatore usiamo le evidenze operative: una valutazione o un
                // appuntamento gia assegnati a una sede sono piu affidabili, soprattutto
                // per OWNER e segreterie che lavorano su piu strutture.
                const evidenceSources = [];
                if (await tableExists(schema, 'evaluations')) {
                    evidenceSources.push(`SELECT e."patientId"::text AS patient_id, e."structureId" AS structure_id
                           FROM "${schema}"."evaluations" e
                          WHERE e."structureId" IS NOT NULL`);
                }
                if (await tableExists(schema, 'agenda_events')) {
                    evidenceSources.push(`SELECT a."patient"->>'id' AS patient_id, a."structureId" AS structure_id
                           FROM "${schema}"."agenda_events" a
                          WHERE a."structureId" IS NOT NULL
                            AND a."patient"->>'id' IS NOT NULL`);
                }
                if (evidenceSources.length > 0) {
                    const uniqueEvidence = `
                        SELECT evidence.patient_id,
                               MIN(evidence.structure_id::text)::uuid AS structure_id
                          FROM (${evidenceSources.join(' UNION ALL ')}) evidence
                         WHERE evidence.patient_id IS NOT NULL
                      GROUP BY evidence.patient_id
                        HAVING COUNT(DISTINCT evidence.structure_id) = 1
                    `;
                    updated += await execute(apply, `UPDATE "${schema}"."patients" p
                            SET "structureId" = evidence.structure_id
                           FROM (${uniqueEvidence}) evidence
                          WHERE p."structureId" IS NULL
                            AND p.id::text = evidence.patient_id`, `SELECT COUNT(*) AS count
                           FROM "${schema}"."patients" p
                           JOIN (${uniqueEvidence}) evidence ON p.id::text = evidence.patient_id
                          WHERE p."structureId" IS NULL`, {});
                }
            }
            updated += single
                ? await execute(apply, `UPDATE "${schema}"."patients" SET "structureId" = :structureId WHERE "structureId" IS NULL`, `SELECT COUNT(*) AS count FROM "${schema}"."patients" WHERE "structureId" IS NULL`, { structureId: single })
                : await execute(apply, `UPDATE "${schema}"."patients" p
                          SET "structureId" = sub.structure_id
                         FROM (${singleStructurePerUser('::text')}) sub
                        WHERE p."structureId" IS NULL AND p."userId" = sub.user_id`, `SELECT COUNT(*) AS count
                         FROM "${schema}"."patients" p
                         JOIN (${singleStructurePerUser('::text')}) sub ON sub.user_id = p."userId"
                        WHERE p."structureId" IS NULL`, { tenantId: tenant.id });
            add('patients', updated);
        }
        // --- Valutazioni: ereditano la sede del paziente ---
        if ((await tableExists(schema, 'evaluations')) && (await tableExists(schema, 'patients'))) {
            const updated = await execute(apply, `UPDATE "${schema}"."evaluations" e
                    SET "structureId" = p."structureId"
                   FROM "${schema}"."patients" p
                  WHERE e."structureId" IS NULL
                    AND e."patientId" = p.id
                    AND p."structureId" IS NOT NULL`, `SELECT COUNT(*) AS count
                   FROM "${schema}"."evaluations" e
                   JOIN "${schema}"."patients" p ON p.id = e."patientId"
                  WHERE e."structureId" IS NULL AND p."structureId" IS NOT NULL`, {});
            add('evaluations', updated);
        }
        // --- Note e promemoria: prima sede del paziente, poi sede univoca dell'assegnatario ---
        for (const linked of [
            { table: 'notes', userField: 'ownerUserId' },
            { table: 'reminders', userField: 'assigneeUserId' }
        ]) {
            if (!(await tableExists(schema, linked.table)))
                continue;
            let updated = 0;
            if (await tableExists(schema, 'patients')) {
                updated += await execute(apply, `UPDATE "${schema}"."${linked.table}" item
                        SET "structureId" = p."structureId"
                       FROM "${schema}"."patients" p
                      WHERE item."structureId" IS NULL
                        AND item."patientId" = p.id
                        AND p."structureId" IS NOT NULL`, `SELECT COUNT(*) AS count
                       FROM "${schema}"."${linked.table}" item
                       JOIN "${schema}"."patients" p ON p.id = item."patientId"
                      WHERE item."structureId" IS NULL AND p."structureId" IS NOT NULL`, {});
            }
            updated += single
                ? await execute(apply, `UPDATE "${schema}"."${linked.table}" SET "structureId" = :structureId WHERE "structureId" IS NULL`, `SELECT COUNT(*) AS count FROM "${schema}"."${linked.table}" WHERE "structureId" IS NULL`, { structureId: single })
                : await execute(apply, `UPDATE "${schema}"."${linked.table}" item
                          SET "structureId" = sub.structure_id
                         FROM (${singleStructurePerUser('')}) sub
                        WHERE item."structureId" IS NULL AND item."${linked.userField}" = sub.user_id`, `SELECT COUNT(*) AS count
                         FROM "${schema}"."${linked.table}" item
                         JOIN (${singleStructurePerUser('')}) sub ON sub.user_id = item."${linked.userField}"
                        WHERE item."structureId" IS NULL`, { tenantId: tenant.id });
            add(linked.table, updated);
        }
        // --- Ferie/permessi: sede univoca del professionista ---
        if (await tableExists(schema, 'time_off_requests')) {
            const updated = single
                ? await execute(apply, `UPDATE "${schema}"."time_off_requests" SET "structureId" = :structureId WHERE "structureId" IS NULL`, `SELECT COUNT(*) AS count FROM "${schema}"."time_off_requests" WHERE "structureId" IS NULL`, { structureId: single })
                : await execute(apply, `UPDATE "${schema}"."time_off_requests" item
                          SET "structureId" = sub.structure_id
                         FROM (${singleStructurePerUser('')}) sub
                        WHERE item."structureId" IS NULL AND item."userId" = sub.user_id`, `SELECT COUNT(*) AS count
                         FROM "${schema}"."time_off_requests" item
                         JOIN (${singleStructurePerUser('')}) sub ON sub.user_id = item."userId"
                        WHERE item."structureId" IS NULL`, { tenantId: tenant.id });
            add('time_off_requests', updated);
        }
        // --- Appuntamenti: sede del professionista titolare del calendario ---
        if (await tableExists(schema, 'agenda_events')) {
            const updated = single
                ? await execute(apply, `UPDATE "${schema}"."agenda_events" SET "structureId" = :structureId WHERE "structureId" IS NULL`, `SELECT COUNT(*) AS count FROM "${schema}"."agenda_events" WHERE "structureId" IS NULL`, { structureId: single })
                : await execute(apply, `UPDATE "${schema}"."agenda_events" a
                          SET "structureId" = sub.structure_id
                         FROM (${singleStructurePerUser('::text')}) sub
                        WHERE a."structureId" IS NULL AND a."calendarId" = sub.user_id`, `SELECT COUNT(*) AS count
                         FROM "${schema}"."agenda_events" a
                         JOIN (${singleStructurePerUser('::text')}) sub ON sub.user_id = a."calendarId"
                        WHERE a."structureId" IS NULL`, { tenantId: tenant.id });
            add('agenda_events', updated);
        }
        // --- Residui ambigui ---
        for (const table of TABLES) {
            if (!(await tableExists(schema, table)))
                continue;
            const remaining = await countNull(schema, table);
            if (remaining > 0) {
                report.ambiguous[table] = (report.ambiguous[table] ?? 0) + remaining;
                if (verbose) {
                    console.log(`[backfill] ${label}/${table}: ${remaining} record senza sede (ambigui)`);
                }
            }
        }
    }
    return backfillTenant;
}
/** A release migration calls this once per tenant, with its existing transaction. */
async function runStructureBackfillTenant(options) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.tenantId)) {
        throw new Error('Invalid tenant id for structure backfill');
    }
    const report = { tenants: 1, updated: {}, ambiguous: {} };
    await createBackfillWorker(options.database, options.transaction)({ id: options.tenantId, businessName: options.businessName ?? null }, true, report, options.verbose ?? false);
    return report;
}

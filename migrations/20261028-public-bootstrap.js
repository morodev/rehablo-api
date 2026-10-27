// Immutable initial production migration. Add subsequent migrations in new files.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicMigrationSteps = publicMigrationSteps;
const { initialScales, initialTests, initialMetrics, initialDeviceSources, initialImportProfiles, images: frozenImages } = require('./baselines/20261028-catalogs.json');
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
/** Existing migration registries are evidence; completed historic effects must not be replayed. */
async function legacyApplied(database, transaction, table, version) {
    const registry = '"public".' + quote(table);
    const [tables] = await database.query('SELECT to_regclass(:registry) AS registry', { transaction, replacements: { registry } });
    if (!tables[0]?.registry)
        return false;
    const [rows] = await database.query(`SELECT version FROM ${registry} WHERE version = :version`, { transaction, replacements: { version } });
    return rows.length > 0;
}
async function repairUserAvailability(database, transaction) {
    const columns = ['rangeOneStart', 'rangeOneFinish', 'rangeTwoStart', 'rangeTwoFinish', 'rangeThreeStart',
        'rangeThreeFinish', 'rangeFourStart', 'rangeFourFinish'];
    const [rows] = await database.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='user_availabilities'", { transaction });
    const present = new Set(rows.map(row => row.column_name));
    const missing = columns.filter(column => !present.has(column));
    for (const column of missing)
        await database.query(`ALTER TABLE public.user_availabilities ADD COLUMN IF NOT EXISTS ${quote(column)} TIME`, { transaction });
    // A lost first finish time cannot be recovered. Preserve the previous conservative repair.
    if (missing.includes('rangeOneFinish'))
        await database.query(`UPDATE public.user_availabilities
        SET enabled=false, ${columns.map(column => quote(column) + '=NULL').join(', ')}, "updatedAt"=NOW()
        WHERE enabled=true`, { transaction });
}
async function backfillIdentityEmails(database, transaction) {
    await database.query(`INSERT INTO public.user_emails
        (id,"userId",email,"normalizedEmail","isPrimary","verifiedAt","createdAt","updatedAt")
        SELECT md5(u.id::text || ':primary-email')::uuid,u.id,btrim(u.email),lower(btrim(u.email)),true,
            CASE WHEN u."isActive" THEN NOW() ELSE NULL END,NOW(),NOW()
        FROM public.users u WHERE btrim(u.email)<>'' ON CONFLICT DO NOTHING`, { transaction });
}
async function backfillOwnerRoles(database, transaction) {
    const queries = [
        `WITH founders AS (
            SELECT DISTINCT ON (tu."tenantId") tu."userId" FROM public.tenant_users tu
            JOIN public.users u ON u.id=tu."userId"
            WHERE tu."tenantId" NOT IN (SELECT tu2."tenantId" FROM public.tenant_users tu2
                JOIN public.users u2 ON u2.id=tu2."userId" WHERE u2."isTenant"=true)
            ORDER BY tu."tenantId",u."createdAt",u.id
        ) UPDATE public.users u SET "isTenant"=true FROM founders f WHERE u.id=f."userId"`,
        `UPDATE public.tenant_users tu SET role='OWNER' FROM public.users u
            WHERE u.id=tu."userId" AND u."isTenant"=true AND tu.role='THERAPIST'`,
        `INSERT INTO public.structure_users ("structureId","userId",role,"createdAt","updatedAt")
            SELECT s.id,tu."userId",NULL,NOW(),NOW() FROM public.tenant_users tu
            JOIN public.structures s ON s."tenantId"=tu."tenantId"
            LEFT JOIN public.structure_users su ON su."structureId"=s.id AND su."userId"=tu."userId"
            WHERE tu.role='OWNER' AND su."userId" IS NULL ON CONFLICT ("structureId","userId") DO NOTHING`,
        `UPDATE public.structure_users su SET role=NULL,"updatedAt"=NOW() FROM public.tenant_users tu,public.structures s
            WHERE tu.role='OWNER' AND s."tenantId"=tu."tenantId" AND su."userId"=tu."userId"
                AND su."structureId"=s.id AND su.role IS NOT NULL`
    ];
    for (const sql of queries)
        await database.query(sql, { transaction });
}
async function migrateStructureCalendars(database, transaction) {
    const version = '20261009-structure-calendars';
    if (await legacyApplied(database, transaction, 'auth_schema_migrations', version))
        return;
    const queries = [
        `ALTER TABLE public.structure_users ADD COLUMN IF NOT EXISTS "calendarEnabled" BOOLEAN NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS "availabilityMode" VARCHAR(32) NOT NULL DEFAULT 'INHERIT_STRUCTURE'`,
        `CREATE TABLE IF NOT EXISTS public.structure_user_availabilities (id UUID PRIMARY KEY,"userId" UUID NOT NULL,
            "structureId" UUID NOT NULL,day INTEGER NOT NULL CHECK(day BETWEEN 0 AND 6),enabled BOOLEAN NOT NULL DEFAULT false,
            "rangeOneStart" TIME,"rangeOneFinish" TIME,"rangeTwoStart" TIME,"rangeTwoFinish" TIME,
            "rangeThreeStart" TIME,"rangeThreeFinish" TIME,"rangeFourStart" TIME,"rangeFourFinish" TIME,
            "createdAt" TIMESTAMPTZ NOT NULL,"updatedAt" TIMESTAMPTZ NOT NULL)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS structure_user_availability_day_unique ON public.structure_user_availabilities ("userId","structureId",day)`
    ];
    for (const sql of queries)
        await database.query(sql, { transaction });
    const [duplicates] = await database.query('SELECT "userId",day FROM public.user_availabilities GROUP BY "userId",day HAVING COUNT(*)>1', { transaction });
    if (duplicates.length)
        throw new Error('Disponibilita legacy duplicate: risolvere prima della migrazione delle agende');
    await database.query(`UPDATE public.structure_users su SET "calendarEnabled"=true,
        "availabilityMode"=COALESCE(u."availabilityMode",'INHERIT_STRUCTURE') FROM public.users u WHERE u.id=su."userId"`, { transaction });
    const timeColumns = ['rangeOneStart', 'rangeOneFinish', 'rangeTwoStart', 'rangeTwoFinish', 'rangeThreeStart', 'rangeThreeFinish', 'rangeFourStart', 'rangeFourFinish'];
    await database.query(`INSERT INTO public.structure_user_availabilities
        (id,"userId","structureId",day,enabled,${timeColumns.map(quote).join(',')},"createdAt","updatedAt")
        SELECT md5(su."userId"::text || su."structureId"::text || days.day::text)::uuid,su."userId",su."structureId",days.day,
            COALESCE(a.enabled,false),${timeColumns.map(column => 'a.' + quote(column)).join(',')},NOW(),NOW()
        FROM public.structure_users su CROSS JOIN generate_series(0,6) AS days(day)
        LEFT JOIN public.user_availabilities a ON a."userId"=su."userId" AND a.day=days.day
        ON CONFLICT ("userId","structureId",day) DO NOTHING`, { transaction });
    await database.query(`CREATE TABLE IF NOT EXISTS public.calendar_preferences (
        "viewerUserId" UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        "structureId" UUID NOT NULL REFERENCES public.structures(id) ON DELETE CASCADE,
        "calendarId" UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),"updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY ("viewerUserId","structureId","calendarId"))`, { transaction });
    const [constraints] = await database.query(`SELECT 1 FROM pg_constraint
        WHERE conrelid='public.structure_user_availabilities'::regclass AND conname='structure_user_availability_membership_fk'`, { transaction });
    if (!constraints.length)
        await database.query(`ALTER TABLE public.structure_user_availabilities
        ADD CONSTRAINT structure_user_availability_membership_fk FOREIGN KEY ("structureId","userId")
        REFERENCES public.structure_users ("structureId","userId") ON DELETE CASCADE`, { transaction });
    await database.query(`CREATE TABLE IF NOT EXISTS public.auth_schema_migrations
        (version VARCHAR(128) PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`, { transaction });
    await database.query('INSERT INTO public.auth_schema_migrations(version) VALUES (:version) ON CONFLICT DO NOTHING', { transaction, replacements: { version } });
}
async function addSecretaryEnum(database, transaction) {
    for (const name of ['enum_tenant_users_role', 'enum_structure_users_role']) {
        await database.query(`ALTER TYPE public.${quote(name)} ADD VALUE IF NOT EXISTS 'ADMIN_SECRETARY'`, { transaction });
    }
}
async function migrateSecretaryRoles(database, transaction) {
    const version = '20261018-secretary-role-separation';
    if (await legacyApplied(database, transaction, 'auth_schema_migrations', version))
        return;
    const [changed] = await database.query(`WITH tenant_changed AS (
        UPDATE public.tenant_users SET role='ADMIN_SECRETARY',"updatedAt"=NOW() WHERE role='SECRETARY' RETURNING "userId"
    ),structure_changed AS (
        UPDATE public.structure_users SET role='ADMIN_SECRETARY',"updatedAt"=NOW() WHERE role='SECRETARY' RETURNING "userId"
    ) SELECT "userId" FROM tenant_changed UNION SELECT "userId" FROM structure_changed`, { transaction });
    const userIds = changed.map(row => row.userId);
    if (userIds.length) {
        await database.query('UPDATE public.users SET "authVersion"=COALESCE("authVersion",0)+1 WHERE id IN (:userIds)', { transaction, replacements: { userIds } });
        await database.query(`UPDATE public.refresh_tokens SET "revokedAt"=NOW(),"revokedReason"=:version
            WHERE "userId" IN (:userIds) AND "revokedAt" IS NULL`, { transaction, replacements: { version, userIds } });
    }
    await database.query(`CREATE TABLE IF NOT EXISTS public.auth_schema_migrations
        (version VARCHAR(128) PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`, { transaction });
    await database.query('INSERT INTO public.auth_schema_migrations(version) VALUES (:version) ON CONFLICT DO NOTHING', { transaction, replacements: { version } });
}
function guardedLegacyMigration(table, filename, version) {
    return async (database, transaction) => {
        if (await legacyApplied(database, transaction, table, version))
            return;
        await require('./' + filename).up(database.getQueryInterface(), { transaction });
    };
}
const jsonColumns = new Set(['districts', 'score', 'interpretation', 'applicableDistricts', 'applicableSides', 'channels', 'producesMetrics', 'definition']);
/** Uses the runner connection and transaction rather than model-bound global Sequelize state. */
async function findOrInsert(database, transaction, table, where, defaults) {
    const whereColumns = Object.keys(where);
    const [existing] = await database.query(`SELECT id FROM public.${quote(table)} WHERE ${whereColumns.map((column, index) => quote(column) + '=:w' + index).join(' AND ')} LIMIT 1`, { transaction, replacements: Object.fromEntries(whereColumns.map((column, index) => ['w' + index, where[column]])) });
    if (existing.length)
        return existing[0].id;
    const values = { id: (0, node_crypto_1.randomUUID)(), ...defaults, ...where };
    const columns = Object.keys(values).filter(column => values[column] !== undefined);
    const replacements = Object.fromEntries(columns.map((column, index) => {
        const value = values[column];
        return ['v' + index, jsonColumns.has(column) && value !== null ? JSON.stringify(value) : value];
    }));
    await database.query(`INSERT INTO public.${quote(table)} (${columns.map(quote).join(',')},"createdAt","updatedAt")
        VALUES (${columns.map((_column, index) => ':v' + index).join(',')},NOW(),NOW())`, { transaction, replacements });
    return values.id;
}
async function seedHumanBodyCatalog(database, transaction) {
    for (const data of initialScales) {
        const scaleId = await findOrInsert(database, transaction, 'scales', { name: data.name }, {
            description: data.description, isFullBody: data.isFullBody, districts: data.isFullBody ? null : data.districts,
            category: data.category, score: data.score, interpretation: data.interpretation
        });
        for (const section of data.sections) {
            const sectionId = await findOrInsert(database, transaction, 'section_scales', { sectionName: section.sectionName, scaleId }, {});
            for (const question of section.questions) {
                const questionScaleId = await findOrInsert(database, transaction, 'question_scales', { description: question.description, scaleId }, { type: question.type, sectionId });
                for (const answer of question.answers)
                    await findOrInsert(database, transaction, 'answer_scales', { description: answer.description, questionScaleId }, { value: answer.value });
            }
        }
    }
    for (const data of initialTests) {
        const { imageFile, ...values } = data;
        const image = imageFile ? Buffer.from(frozenImages[imageFile], 'base64') : null;
        await findOrInsert(database, transaction, 'tests', { name: data.name }, { ...values, image, districts: data.isFullBody ? null : data.districts });
    }
}
async function seedMeasurementCatalog(database, transaction) {
    for (const data of initialMetrics)
        await findOrInsert(database, transaction, 'metric_definitions', { code: data.code }, data);
    for (const data of initialDeviceSources)
        await findOrInsert(database, transaction, 'device_sources', { sourceId: data.sourceId }, data);
    for (const data of initialImportProfiles)
        await findOrInsert(database, transaction, 'import_profiles', { sourceId: data.sourceId }, data);
}
/** Frozen transition steps. Future migrations belong in new modules, preserving these checksums. */
function publicMigrationSteps() {
    const source = (0, node_fs_1.readFileSync)(__filename, 'utf8').replaceAll('\r\n', '\n');
    const step = (name, up, dependencies = []) => {
        const checksum = (0, node_crypto_1.createHash)('sha256').update(name).update(source);
        for (const dependency of dependencies)
            checksum.update(dependency);
        return { name, scope: 'public', checksum: checksum.digest('hex'),
            up: (database, _schema, transaction) => up(database, transaction) };
    };
    const migrationSource = (filename) => (0, node_fs_1.readFileSync)(require('node:path').join(__dirname, filename), 'utf8').replaceAll('\r\n', '\n');
    const images = initialTests.filter(test => test.imageFile).map(test => Buffer.from(frozenImages[test.imageFile], 'base64'));
    return [
        step('20261028-public-availability-repair-v1', repairUserAvailability),
        step('20261028-public-identity-emails-v1', backfillIdentityEmails),
        step('20261028-public-owner-roles-v1', backfillOwnerRoles),
        step('20261028-public-auth-security-v1', guardedLegacyMigration('auth_security_migrations', '20261012-auth-security-public.js', '20261012-auth-security-public'), [migrationSource('20261012-auth-security-public.js')]),
        step('20261028-public-secretary-enum-v1', addSecretaryEnum),
        step('20261028-public-secretary-roles-v1', migrateSecretaryRoles),
        step('20261028-public-structure-calendars-v1', migrateStructureCalendars),
        step('20261028-public-activity-notifications-v1', guardedLegacyMigration('activity_notification_migrations', '20261011-activities-notifications-public.js', '20261011-activities-notifications-public'), [migrationSource('20261011-activities-notifications-public.js')]),
        step('20261028-public-human-body-seed-v1', seedHumanBodyCatalog, [JSON.stringify({ initialScales, initialTests }), ...images]),
        step('20261028-public-measurements-seed-v1', seedMeasurementCatalog, [JSON.stringify({ initialMetrics, initialDeviceSources, initialImportProfiles })])
    ];
}

'use strict';
const VERSION = '20261018-secretary-role-separation';
module.exports = {
    async up(queryInterface) {
        const db = queryInterface.sequelize;
        // New enum values must be committed before their first use in the backfill.
        for (const name of ['enum_tenant_users_role', 'enum_structure_users_role']) {
            await db.query(`ALTER TYPE public."${name}" ADD VALUE IF NOT EXISTS 'ADMIN_SECRETARY'`);
        }
        await db.transaction(async transaction => {
            const query = sql => db.query(sql, {transaction});
            await query("SELECT pg_advisory_xact_lock(hashtext('rehablo-secretary-role-separation'))");
            await query("CREATE TABLE IF NOT EXISTS public.auth_schema_migrations (version VARCHAR(128) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
            const [done] = await db.query('SELECT version FROM public.auth_schema_migrations WHERE version = :version', {transaction, replacements: {version: VERSION}});
            if (done.length) return;
            const [changed] = await query(`WITH tenant_changed AS (
                UPDATE public.tenant_users SET role = 'ADMIN_SECRETARY', "updatedAt" = NOW() WHERE role = 'SECRETARY' RETURNING "userId"
            ), structure_changed AS (
                UPDATE public.structure_users SET role = 'ADMIN_SECRETARY', "updatedAt" = NOW() WHERE role = 'SECRETARY' RETURNING "userId"
            ) SELECT "userId" FROM tenant_changed UNION SELECT "userId" FROM structure_changed`);
            const userIds = changed.map(row => row.userId);
            if (userIds.length) {
                await db.query('UPDATE public.users SET "authVersion" = COALESCE("authVersion", 0) + 1 WHERE id IN (:userIds)', {transaction, replacements: {userIds}});
                await db.query('UPDATE public.refresh_tokens SET "revokedAt" = NOW(), "revokedReason" = :reason WHERE "userId" IN (:userIds) AND "revokedAt" IS NULL', {transaction, replacements: {userIds, reason: VERSION}});
            }
            await db.query('INSERT INTO public.auth_schema_migrations(version) VALUES (:version)', {transaction, replacements: {version: VERSION}});
        });
    },
    async down() {throw new Error('La separazione delle segreterie richiede una migrazione esplicita delle assegnazioni.');}
};

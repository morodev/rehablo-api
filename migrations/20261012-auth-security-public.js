'use strict';
const VERSION = '20261012-auth-security-public';
module.exports = {
    VERSION,
    async up(queryInterface, options = {}) {
        if (!options.transaction) return queryInterface.sequelize.transaction(transaction =>
            module.exports.up(queryInterface, { ...options, transaction }));
        const run = sql => queryInterface.sequelize.query(sql, { transaction: options.transaction });
        await run("SELECT pg_advisory_xact_lock(hashtext('public'), hashtext('auth-security-public'))");
        await run('ALTER TABLE "public"."users" ADD COLUMN IF NOT EXISTS "authVersion" INTEGER NOT NULL DEFAULT 0');
        await run('ALTER TABLE "public"."refresh_tokens" ADD COLUMN IF NOT EXISTS "authVersion" INTEGER NOT NULL DEFAULT 0');
        await run(`CREATE TABLE IF NOT EXISTS "public"."account_action_tokens" (
            "id" UUID PRIMARY KEY,
            "userId" UUID NOT NULL REFERENCES "public"."users" ("id") ON DELETE CASCADE,
            "tokenHash" VARCHAR(64) NOT NULL,
            "purpose" VARCHAR(32) NOT NULL CHECK ("purpose" IN ('verify_email', 'reset_password')),
            "normalizedEmail" VARCHAR(320) NOT NULL,
            "expiresAt" TIMESTAMPTZ NOT NULL,
            "consumedAt" TIMESTAMPTZ NULL,
            "invalidatedAt" TIMESTAMPTZ NULL,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await run('CREATE UNIQUE INDEX IF NOT EXISTS "account_action_tokens_hash_uq" ON "public"."account_action_tokens" ("tokenHash")');
        await run('CREATE INDEX IF NOT EXISTS "account_action_tokens_user_purpose_idx" ON "public"."account_action_tokens" ("userId", "purpose")');
        await run('CREATE INDEX IF NOT EXISTS "account_action_tokens_expiry_idx" ON "public"."account_action_tokens" ("expiresAt")');
        await run(`CREATE TABLE IF NOT EXISTS "public"."auth_security_migrations" (
            "version" VARCHAR(160) PRIMARY KEY, "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await queryInterface.sequelize.query(`INSERT INTO "public"."auth_security_migrations" ("version")
            VALUES (:version) ON CONFLICT ("version") DO NOTHING`,
        { transaction: options.transaction, replacements: { version: VERSION } });
    },
    async down() { throw new Error('Session revocation state cannot be removed automatically.'); }
};

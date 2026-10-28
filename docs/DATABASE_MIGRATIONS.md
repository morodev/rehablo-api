# Database migrations

The API uses Sequelize v6 and the standard Sequelize CLI. Shared tables live in `public`; business tables live in each tenant's `rehablo_<tenantId>` schema. Changing a model does not alter an existing database table.

## Deployment and commands

The Render blueprint configures:

1. Build: `npm ci && npm run build`.
2. Pre-deploy: empty.
3. Start: `npm start`; health check: `/health`.

`npm start` runs `npm run db:migrate && node dist/server.js`. The service has a persistent disk: Render stops the preceding instance before running the replacement start command. This puts migrations after the old API has closed its database connections and released transaction locks, including the tenant lock used by its legacy model sync. The API starts only after the CLI succeeds; a migration failure prevents the listener from opening.

For an existing Render service, clear **Settings > Build & Deploy > Pre-Deploy Command** and keep **Start Command** set to `npm start` when deploying this change. Updating `render.yaml` alone does not update manually configured services. Keep the existing disk mount, environment and database unchanged. The interruption includes migration time, within Render's 15-minute startup limit. This ordering relies on the attached persistent disk; a service without a disk needs a separately coordinated migration rollout.

`db:migrate` runs `sequelize-cli db:migrate` using `migrations/config.cjs` and the migration files in `migrations/releases/`. The CLI records completed filenames in `public.SequelizeMeta` and runs only pending files. A migration error exits unsuccessfully and stops the deployment; never add a successful marker manually to bypass a failure.

`npm run db:status` runs the CLI's `db:migrate:status` and lists each migration as up or down. `npm run db:check` reads the required migration markers without applying changes: exit 0 means ready, 2 means pending migrations, and 1 means an execution error. Build before running migrations or the application readiness check; retain `migrations/` alongside `dist/`.

The CLI uses the same `DATABASE_URL`, local fallback and `DB_SSL` interpretation as the application. Existing endpoint, database and environment settings do not need to change. Old `DATABASE_MIGRATION_PHASE` and `TENANT_SCHEMA_SYNC` settings do not select an alternative migration workflow.

Run one migration process at a time. Render serializes deployments for this service; do not launch another CLI migration or a legacy schema writer against the same database during startup. Transaction-scoped tenant locks remain in place; changing the startup order avoids contention with this service's preceding instance instead of bypassing active writers. If the same lock timeout persists, another database session still owns the lock and must be identified; startup never terminates external sessions or marks failed migrations as applied.

## Local development

After installing dependencies, configuring the local `.env` and starting PostgreSQL, run `npm run build`, then `npm run db:migrate`, then `npm run dev`. The build supplies the compiled implementation imported by the CLI migration files. Repeat build and migration after pulling changes with pending migrations; the CLI skips completed files. `npm run dev` watches the application and checks migration status on startup. It does not apply pending migrations, so `DATABASE_SCHEMA_NOT_READY` requires running the migration command before restarting development.

## Existing installations and tenants

`202610280001-initial-schema.js` creates or adopts the initial public and tenant schema using the existing historical migration records. Existing `schema_migrations` versions and timestamps are preserved, and completed historical data migrations are not replayed. `202610280002-appointment-reminders.js` adds appointment reminder delivery storage. Both call the compiled migration implementation through the CLI's own database connection.

Public steps use explicit transactions; enum additions commit before later steps use the new values. Tenant schema changes and their per-tenant migration markers commit together. If a tenant fails, its transaction rolls back. Correct the cause and rerun `npm run db:migrate`; already completed tenant steps remain recorded.

After the start command finishes migrations, the API bootstrap reads `SequelizeMeta` to check that required global migrations have completed. It also adopts legacy tenants whose schema has no `SequelizeMeta` table. Existing tenant metadata is checked on access; startup does not repair missing rows in an existing `SequelizeMeta` table. Use `npm run db:check -- --tenants` for a read-only check of every tenant's migration markers. During the CLI migration phase the HTTP listener is not running. Once the API starts, health and application routes remain at HTTP 503 until initialization succeeds. Migrations, API bootstrap and ordinary requests never call business `Model.sync`, `alter` or `force`.

New tenant registration provisions its schema in the registration transaction. A failure rolls back the tenant and schema together. The configured Render service has a persistent disk, so deployments include downtime. Keep migrations additive and preserve compatibility with existing business data.

## Adding a migration

Add a new timestamped JavaScript file to `migrations/releases/` with the standard `up(queryInterface, Sequelize)` and `down(queryInterface, Sequelize)` exports. Use `queryInterface` or `queryInterface.sequelize` and pass the transaction explicitly to every operation that belongs together.

When the application requires the new migration, append its exact filename to `requiredMigrationNames` in `src/database/migrationStatus.ts`. This list is checked against both global and tenant metadata. Update the migration to record its filename for each tenant, and update `provisionTenantSchema` in `src/database/standardMigrations.ts` to apply the same tenant changes and marker when registering a new tenant. Commit each tenant's changes and marker in the same transaction. Verify existing-tenant upgrade, new registration and retry after a failure; adding a CLI file alone does not update new-tenant provisioning.

For future tenant migrations, extend `reconcileTenantSchemas` to find existing tenant `SequelizeMeta` tables missing the newly required filename. Its current table-absence check covers the initial legacy adoption only. Test a registration committed by the preceding API after the CLI has discovered its tenant list, so that tenant also receives the new migration.

Keep applied migration files and frozen baseline/catalog artifacts unchanged. The initial adoption and reminder migrations deliberately reject automatic `down`: reverting either could destroy existing business data or delivery history. Recover through a reviewed corrective migration or a coordinated backup restore.

## Verification

`npm run test:database:integration` requires `TEST_MIGRATIONS_DATABASE_URL` for an empty disposable PostgreSQL database on localhost, named `<prefix>_migrations_test` or `<prefix>_migrations_test_<run>`. The test guard never substitutes `DATABASE_URL` and rejects the ordinary application database. The startup integration test reproduces the reported `55P03` with a separate legacy writer process, verifies rollback and lock release after that process stops, then executes the real `npm start`, checks `/health`, and verifies a second start preserves data and migration history. It also checks that migration failure prevents API startup. Report PostgreSQL checks actually executed separately from unit tests.

Official references: [Sequelize v6 migrations and SequelizeMeta](https://sequelize.org/docs/v6/other-topics/migrations/), [Sequelize transactions](https://sequelize.org/docs/v6/other-topics/transactions/), [Render pre-deploy commands](https://render.com/docs/deploys#pre-deploy-command), [Render persistent-disk deployment ordering](https://render.com/docs/disks#disk-limitations-and-considerations).

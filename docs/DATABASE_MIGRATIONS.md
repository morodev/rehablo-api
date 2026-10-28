# Database migrations and deployment

The API uses Sequelize v6 with PostgreSQL: shared tables live in `public`, and business tables live in one schema per tenant. Schema changes are explicit, versioned migrations executed by Umzug. Changing a TypeScript model does not change an existing database table.

## Deploying an existing or a new database

Use one ordinary deployment. No bridge release, phase environment variable, or manual SQL marker is required.

The Render configuration is:

- Build: `npm ci && npm run build`
- Pre-deploy: `npm run db:migrate`
- Start: `npm start`
- Health check: `/health`

Pre-deploy applies pending public and tenant migrations. Startup runs the same idempotent runner after opening the HTTP listener and before declaring the API ready or starting background jobs. This also supports existing services configured with only `npm start`, and catches a tenant created by the preceding API between pre-deploy and its retirement. Health and application routes return HTTP 503 while initialization is running; they become available only after migrations succeed. Startup never uses `Model.sync`, `alter`, or `force`.

The obsolete `DATABASE_MIGRATION_PHASE` setting is ignored with a warning, including an old `bridge` override. There is no need to toggle environment variables between deployments. Existing bridge metadata is left untouched and is not a prerequisite. `TENANT_SCHEMA_SYNC` no longer enables runtime synchronization. Keep application database URLs, secrets and provider settings unchanged.

Existing `schema_migrations` rows and timestamps are preserved. Completed historical migrations are not replayed. The frozen baseline adds missing structures and verifies existing column types and constraints; incompatible definitions fail with a concrete error instead of being silently rewritten. Fresh databases and new tenant registration use that same migration manifest.

Release migration and new tenant provisioning share PostgreSQL locks. Each tenant's schema/data changes, migration history and readiness checkpoint commit together. A failure rolls back that tenant and leaves the release incomplete. A retry skips work already committed for other tenants. Already completed compatible releases do no schema changes or historical imports; startup adds only a read-only check for missing tenant checkpoints. An older compatible application cannot reconcile or provision a newer database release back to its older manifest.

The configured Render service has a persistent private-files disk. Render stops the previous service instance before starting its replacement, so the startup check runs after that instance has retired. Other independently deployed legacy services connected to the same database must also be retired during the initial migration; their old code does not participate in the new provisioning lock. Do not describe this deployment as zero downtime. Keep schema changes additive while previous application versions can still serve traffic.

## Commands and routine releases

- `npm run db:migrate`: apply only pending migrations and reconcile missing tenant checkpoints. A failure exits 1 and must fail the deployment.
- `npm run db:status`: report database compatibility without applying changes. Add `-- --tenants` to include tenant checkpoints.
- `npm run db:check`: report compatibility without applying changes. Exit 0 means ready, 2 means not ready, and 1 means an execution error.

Commands use compiled `dist/scripts/databaseMigrations.js`, the current environment's database configuration and the manifest in that build. Build first and retain `migrations/` alongside `dist/`. Checking a local database does not verify production; checking an old build does not verify the requirements of a future release. The CLI reports startup, migration progress and failures, including configuration/artifact import failures.

For each database change, append a new immutable migration to the manifest. Keep published migration modules and frozen schema/catalog JSON unchanged: source tooling and compiled runtime derive identical checksums from those artifacts. A file added to `migrations/` without registration in the manifest does not run automatically. Never mark failed work complete to bypass an error.

For every release, record the frontend/backend commit identifiers, newly required environment settings, database migrations and any deployment order. UI-only changes generally do not need database migrations. A new environment variable and a database migration are independent requirements.

`MIGRATION_CONCURRENCY` defaults to 2. `MIGRATION_STATEMENT_TIMEOUT_MS` defaults to 120000 and applies inside migration transactions, not to ordinary API queries. For maintenance checks, `BACKGROUND_JOBS_ENABLED=false` skips background cleanup, completion, reconciliation and delivery jobs; jobs remain enabled by default. Migration scripts do not initialize notification activation cutoffs or send messages.

Global release lock acquisition retries for up to five minutes, within the overall release deadline. It uses nonblocking advisory lock attempts so an overlapping legacy bootstrap can finish its nested shared-lock operations. Migration SQL retains its ten-second lock timeout and configured statement timeout; SQL failures still abort deployment. Progress distinguishes `release-lock-acquiring`, `release-lock-waiting`, `release-lock-acquired`, metadata initialization and individual migrations. A release lock timeout identifies the advisory lock and the coordination phase; it does not mean the migration named by the release ID has started.

## Recovery and verification

Use the failed deployment's migration/schema details and `npm run db:status -- --tenants` to locate incomplete work. Correct the cause and retry the same artifact. Code rollback does not undo database migrations; use a new corrective migration, and coordinate destructive recovery with a database backup and compatible application versions.

`npm run test:database:integration` requires `TEST_MIGRATIONS_DATABASE_URL` pointing to an empty disposable PostgreSQL database on localhost, named `<prefix>_migrations_test` or `<prefix>_migrations_test_<run>`. It validates isolation before loading application configuration and never falls back to `DATABASE_URL`.

Tests cover fresh database creation, direct adoption of legacy schema/history without bridge metadata, compiled deployment/readiness, transactional rollback and retry, concurrent runners, tenant provisioning and reconciliation, immutable migration checksums, and preservation of historical payment/publication state. Report which PostgreSQL tests actually ran; unit tests alone do not verify database behavior. No test connects to production.

## Official references

- [Sequelize v6 migrations](https://sequelize.org/docs/v6/other-topics/migrations/): versioned changes, migration storage, schemas and programmatic execution with Umzug.
- [Sequelize v6 synchronization in production](https://sequelize.org/docs/v6/core-concepts/model-basics/#synchronization-in-production): use migrations instead of production `sync({alter:true})` or `sync({force:true})`.
- [Sequelize v6 transactions](https://sequelize.org/docs/v6/other-topics/transactions/): explicit transaction propagation and automatic commit/rollback.
- [Umzug](https://github.com/sequelize/umzug): pending/executed migrations and transaction-aware custom storage.
- [Render pre-deploy commands](https://render.com/docs/deploys#pre-deploy-command) and [persistent disk deployment](https://render.com/docs/disks#disk-limitations-and-considerations): separate pre-deploy compute and retirement of the old disk-backed instance before startup.

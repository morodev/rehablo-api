# Database migrations and deployment

The API uses PostgreSQL with shared tables in `public` and business tables in one schema per tenant. Schema changes belong to the versioned migration manifest. In the managed phase, starting an API process or obtaining tenant models must not synchronize models, inspect every tenant, repair schemas, or seed data.

## Transition from the legacy bootstrap

Existing installations require **two ordered releases**. `render.yaml` selects the final `DATABASE_MIGRATION_PHASE=managed` configuration. Use `render.bridge.yaml`, or configure that same deployed environment variable as `bridge`, for the first rollout only. Before the managed rollout, verify the deployed value is `managed`, including any temporary environment override.

1. **Bridge release (`bridge`)**: pre-deploy `npm run db:migrate` creates only control and transition metadata. The bridge API then runs the legacy bootstrap under a shared release lock and records `schema_transition` completion only after bootstrap succeeds. Startup synchronization can therefore still appear during this transitional release. Wait until the bridge service is ready and **retire every pre-bridge API/worker instance** before promotion. The database handshake confirms a bridge bootstrap completed; it cannot prove older processes have been retired.
2. **Managed release (`managed`)**: restore the standard `render.yaml` configuration, including any environment override. Pre-deploy automatically checks the bridge handshake, migrates public and tenant schemas, and starts the new API only after success. Existing tenants without the handshake fail pre-deploy with an explicit error; a fresh database is allowed without a bridge. Subsequent releases stay managed and run pending migrations automatically, with no recurring manual database commands.

The pre-deploy runner and tenant provisioning coordinate through database locks. Existing tenants are migrated with bounded concurrency. A tenant transaction commits its schema/data changes together with its migration history and version. Failed tenant work rolls back, leaves the release incomplete, and can be retried; tenants already completed are skipped on retry. A completed release is published only after every eligible tenant has reached the manifest version.

The managed API checks database compatibility before becoming ready and does not complete migrations itself. A still-running bridge instance rechecks release readiness inside its shared lock and skips the legacy bootstrap after managed migrations complete. Tenant registration acquires its shared transaction lock before writing shared rows, checks the current release, and publishes the new tenant only after provisioning commits. A failed pre-deploy command must fail the deployment; do not bypass it by starting the new image manually. Keep incompatible/destructive schema changes in a later release after old code has been retired. Moving migrations out of startup does **not** guarantee zero-downtime deployment for this Render service with its persistent private-files disk.

## Migration workflow

- `npm run db:migrate`: Render runs this automatically before startup. In bridge mode it initializes transition metadata; in managed mode it applies pending versioned public and tenant migrations.
- `npm run db:status`: inspect release compatibility without applying schema changes; add `-- --tenants` to include tenant checkpoints.
- `npm run db:check`: check release compatibility without applying schema changes; exit `2` means migrations are required, and an execution error exits `1`.

These commands run compiled `dist/scripts/databaseMigrations.js`; build the artifact first with `npm run build` and retain `migrations/` alongside `dist/`. They use the existing application database configuration and the same `DATABASE_MIGRATION_PHASE` as the API. Never modify a published migration's checksum or mark a failed migration complete to bypass an error: add a new migration or correct the cause and retry the same artifact.

Source and compiled runtimes load the same immutable migration modules and frozen schema/catalog JSON under `migrations/`. Their checksums are independent of TypeScript transpilation and normalize text line endings. Catalog images are included in the frozen catalog artifact, so migrations do not read the application's runtime image directories. Keep these published artifacts unchanged and add future changes as new migrations.

The initial versioned baseline is explicit DDL for new databases and tenants. Existing tenant baselines are adopted only after their prerequisites have been verified. New tenants use the same manifest and version history as release migrations; provisioning must finish before registration publishes the tenant. Registering another model or changing its TypeScript definition does not change a production table. Add a versioned migration for every database change.

## Recovery and diagnostics

Use deployment errors to locate a failed tenant/migration, and `npm run db:status -- --tenants` to compare committed tenant checkpoints with the target release. Fix a failure before retrying the deployment. Successful tenant transactions need not be repeated, and an unchanged release performs no tenant DDL, historical import, repair, model sync, or tenant enumeration.

Database rollback and application rollback are separate operations. Keep additive migrations compatible with the serving release, and use a follow-up migration for a verified correction. Destructive recovery requires a database backup and coordinated application versions; the runner must not erase committed business data automatically.

## Verification with PostgreSQL

`npm run test:database:integration` requires an explicitly supplied `TEST_MIGRATIONS_DATABASE_URL`. It validates that URL before importing application configuration and never falls back to `DATABASE_URL`. The target must be on localhost, named `<prefix>_migrations_test` or `<prefix>_migrations_test_<run>`, and different from the ordinary application database even when credentials or loopback aliases differ. Use an empty disposable database exclusively for this suite: it creates and removes migration-control fixtures and synthetic tenant schemas.

The suite covers unchanged-release no-op behavior, transactional rollback and retry, concurrent release runners, coordination with tenant provisioning, lock timeouts, fresh-public/fresh-tenant baseline parity, and preserved legacy payment/publication state. Financial domain smoke verification remains part of rollout checks. Build and unit checks alone cannot establish PostgreSQL transaction or advisory-lock behavior. Report which database tests actually ran and which were unavailable; the presence of these tests is not a production deployment check.

## Official references

- [Sequelize: synchronization in production](https://sequelize.org/docs/v6/core-concepts/model-basics/#synchronization-in-production) explains why production schema evolution should use migrations instead of model `sync({alter:true})` or `sync({force:true})`.
- [Sequelize: programmatic migrations](https://sequelize.org/docs/v6/other-topics/migrations/#programmatic-usage) points to Umzug for executing migrations and recording completed work.
- [Render: pre-deploy commands](https://render.com/docs/deploys#pre-deploy-command) run after build and before deployment, on a separate instance without the service's persistent disk. [Render's deploy documentation](https://render.com/docs/deploys#zero-downtime-deploys) also describes the persistent-disk limitation on zero-downtime deploys.

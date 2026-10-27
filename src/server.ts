import billingRoutes from './modules/billing/routes/billing.routes.js';
import {billingWebhook} from './modules/billing/controllers/billing.controller.js';
import {syncBillingModels} from './modules/billing/models/billing.model.js';
import { migrateStructureCalendars } from './modules/auth/services/structureCalendarMigration.service.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import bodyParser from 'body-parser';

import { env } from './config/env.js';
import { connectDatabase, sequelize } from './config/database.js';
import {databaseManifest} from './database/migrationManifest.js';
import {assertDatabaseReady, withSharedReleaseLock} from './database/releaseControl.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';

import { registerAuthAssociations, syncAuthModels, Tenant } from './modules/auth/models/index.js';
import { syncInvoicePublicModels } from './modules/invoice/models/index.js';
import { assignBootstrapRoles } from './modules/auth/rbac/bootstrap.js';
import { purgeExpiredRefreshTokens } from './modules/auth/services/refreshToken.service.js';
import { runStructureBackfill } from './modules/auth/services/structureBackfill.service.js';
import { registerTenantModels } from './tenantModelsRegistry.js';
import { registerCatalogAssociations, syncCatalogModels, seedCatalogData } from './modules/human-body/models/catalog/index.js';
import { registerProtocolCatalogAssociations, syncProtocolCatalogModels } from './modules/protocols/models/catalog/index.js';
import { syncMeasurementCatalogModels, seedMeasurementCatalogData } from './modules/measurements/models/catalog/index.js';
import { startAutomaticAppointmentCompletionSweep } from './modules/agenda/services/missedArrivalAutomation.service.js';
import {startReminderExternalDeliverySweep} from './modules/notes/services/reminderExternalDelivery.service.js';
import {startPatientContactReminderSweep} from './modules/notes/services/patientContactReminder.service.js';
import {startActivityDeliverySweep} from './modules/activities/services/activityDelivery.service.js';
import activityNotificationsRoutes from './modules/activities/routes/activityNotifications.routes.js';
import {warmTenantSchemas} from './utils/tenantSchema.js';
import {createStartupReadiness, runStartupPhase, startHttpServer} from './utils/serverStartup.js';

import authRoutes from './modules/auth/routes/auth.routes.js';
import patientRoutes from './modules/patients/routes/patient.routes.js';
import productsServicesRoutes from './modules/products-services/routes/products-services.routes.js';
import invoiceRoutes from './modules/invoice/routes/invoice.routes.js';
import invoiceShareRoutes from './modules/invoice/routes/invoiceShare.routes.js';
import agendaRoutes from './modules/agenda/routes/agenda.routes.js';
import configurationRoutes from './modules/configuration/routes/configuration.routes.js';
import humanBodyRoutes from './modules/human-body/routes/human-body.routes.js';
import protocolRoutes from './modules/protocols/routes/protocol.routes.js';
import evaluationRoutes from './modules/evaluations/routes/evaluation.routes.js';
import measurementsRoutes from './modules/measurements/routes/measurements.routes.js';
import noteRoutes from './modules/notes/routes/note.routes.js';
import activitiesRoutes from './modules/activities/routes/activities.routes.js';
import maintenanceRoutes from './modules/maintenance/routes/maintenance.routes.js';
import reportsRoutes from './modules/reports/routes/reports.routes.js';
import patientPortalRoutes from './modules/patient-portal/routes/patientPortal.routes.js';
import administrationRoutes from './modules/administration/routes/administration.routes.js';
import financialOptionsRoutes from './modules/administration/routes/financialOptions.routes.js';
import treasuryIntegrityRoutes from './modules/administration/routes/treasuryIntegrity.routes.js';
import quoteShareRoutes from './modules/administration/routes/quoteShare.routes.js';
import { syncQuotePublicModels } from './modules/administration/models/quoteDelivery.model.js';
import {markBridgeComplete} from './database/schemaTransition.js';
import {getDatabaseStatus} from './database/releaseRunner.js';

async function bootstrap() {
    const app = express();
    const readiness = createStartupReadiness();

    app.use(helmet());
    app.use(
        cors({
            origin(requestOrigin, callback) {
                // Nessun header Origin (curl, health check, richieste server-to-server): consenti.
                if (!requestOrigin) return callback(null, true);

                if (env.corsOrigin.includes('*') || env.corsOrigin.includes(requestOrigin)) {
                    return callback(null, true);
                }

                console.warn(`[cors] origin rifiutato: "${requestOrigin}" (consentiti: ${env.corsOrigin.join(', ')})`);
                return callback(new Error(`Origin "${requestOrigin}" non consentito da CORS`));
            }
        })
    );
    app.use(morgan(env.isProduction ? 'combined' : 'dev'));
    app.get('/health', readiness.health);
    // Include anonymous shares and Stripe: no controller or body parser runs during bootstrap.
    app.use(readiness.requireReady);
    // Stripe signatures must be verified against the original bytes, before JSON parsing.
    app.post('/billing/webhook', express.raw({type: 'application/json', limit: '1mb'}), billingWebhook);
    app.use(bodyParser.urlencoded({ extended: false }));
    app.use(bodyParser.json());

    // Keep the anonymous share endpoint before root-mounted authenticated routers.
    app.use(invoiceShareRoutes);
    app.use(quoteShareRoutes);


    // --- Domain routers (every module owns its own URL prefix-free routes, mounted at root) ---
    app.use(billingRoutes);
    app.use(authRoutes);
    app.use(patientPortalRoutes);
    // Handle Activities before legacy routers whose root middleware performs lazy schema sync.
    app.use(activityNotificationsRoutes);
    app.use(activitiesRoutes);
    app.use(patientRoutes);
    app.use(productsServicesRoutes);
    app.use(invoiceRoutes);
    app.use(agendaRoutes);
    app.use(configurationRoutes);
    app.use(humanBodyRoutes);
    app.use(protocolRoutes);
    app.use(evaluationRoutes);
    app.use(measurementsRoutes);
    app.use(noteRoutes);
    app.use(maintenanceRoutes);
    app.use(reportsRoutes);
    app.use(administrationRoutes);
    app.use(financialOptionsRoutes);
    app.use(treasuryIntegrityRoutes);

    app.use(notFoundHandler);
    app.use(errorHandler);

    await startHttpServer(app, env.port, readiness, initializeApplication);
}

async function initializeApplication(): Promise<void> {
    await runStartupPhase('database connection', connectDatabase);
    registerAuthAssociations();
    registerCatalogAssociations();
    registerProtocolCatalogAssociations();
    registerTenantModels();

    if (env.databaseMigrationPhase === 'bridge') {
        // The transition release participates in the same deployment lock as the new runner.
        // The following managed release cannot migrate while this legacy bootstrap is active.
        await withSharedReleaseLock(sequelize, async () => {
            if ((await getDatabaseStatus(databaseManifest, sequelize)).ready) {
                await assertDatabaseReady(databaseManifest, sequelize);
            } else {
                await initializeLegacySchema();
                await markBridgeComplete(sequelize);
            }
        });
    } else {
        await runStartupPhase('database release compatibility', () => assertDatabaseReady(databaseManifest, sequelize));
    }
    await initializeBackgroundJobs();
}

/** Transitional bootstrap only; managed web processes never synchronize or migrate schemas. */
async function initializeLegacySchema(): Promise<void> {
    await runStartupPhase('public auth models', syncAuthModels);
    await runStartupPhase('public billing models', syncBillingModels);
    // Il link di consegna della fattura vive in `public`: dev'essere risolvibile da una richiesta
    // anonima, che non ha un tenant da cui derivare lo schema.
    await runStartupPhase('public invoice models', syncInvoicePublicModels);
    await runStartupPhase('public quote models', syncQuotePublicModels);

    // RBAC: allinea i ruoli delle membership preesistenti (vedi docs/RBAC_DESIGN.md)
    await runStartupPhase('bootstrap roles', assignBootstrapRoles);
    await runStartupPhase('structure calendars', migrateStructureCalendars);

    // RBAC: assegna la sede ai record che ne sono privi, così lo scope `structure` può
    // diventare stretto. Idempotente e non distruttivo (tocca solo `structureId IS NULL`),
    // quindi può girare a ogni avvio senza bisogno di interventi manuali sul server.
    try {
        const backfill = await runStartupPhase('structure backfill', () => runStructureBackfill({ apply: true }));
        const updated = Object.entries(backfill.updated);
        if (updated.length > 0) {
            const detail = updated.map(([table, count]) => `${table}=${count}`).join(', ');
            console.log(`[rbac] backfill structureId completato: ${detail}`);
        }
        const ambiguous = Object.entries(backfill.ambiguous);
        if (ambiguous.length > 0) {
            const detail = ambiguous.map(([table, count]) => `${table}=${count}`).join(', ');
            console.warn(
                `[rbac] backfill structureId: record senza sede non assegnabili automaticamente (${detail}). ` +
                    'Restano esclusi dalle API operative finche non viene assegnata manualmente una sede.'
            );
        }
    } catch (err) {
        // Un problema qui non deve impedire l'avvio. Per sicurezza i record senza sede
        // restano esclusi dalle API operative, evitando visibilita cross-sede.
        console.error('[rbac] backfill structureId fallito', err);
    }

    // Public-schema human-body catalog (standardized scales/tests, shared by every tenant).
    // Seeded exactly once at boot here, instead of on every single GET request like the legacy
    // rehablo-human-body microservice used to do.
    await runStartupPhase('human-body catalog models', syncCatalogModels);
    await runStartupPhase('human-body catalog seed', seedCatalogData);

    // Public-schema rehabilitation protocols catalog (exercises + reusable protocol templates,
    // shared by every tenant). No seed data yet: managed via the /exercises and /protocol-templates CRUD.
    await runStartupPhase('protocol catalog models', syncProtocolCatalogModels);

    // Public-schema measurement dictionary (Clinical Data Dictionary): definizioni metriche condivise
    // da tutti i tenant. È il fondamento del modello canonico (docs/REHABLO_OS_GAP_ANALYSIS.md §3).
    await runStartupPhase('measurement catalog models', syncMeasurementCatalogModels);
    await runStartupPhase('measurement catalog seed', seedMeasurementCatalogData);

    // Register first, then upgrade every existing tenant before accepting traffic. This moves
    // DDL and data migrations out of the first user request after a deploy.
    const tenantRows = await runStartupPhase('tenant discovery', () => Tenant.findAll({attributes: ['id'], raw: true})) as unknown as Array<{id: string}>;
    console.log(`[database] inizializzazione di ${tenantRows.length} tenant prima di abilitare le API`);
    const readyTenants = await runStartupPhase('tenant schemas', () => warmTenantSchemas(
        tenantRows.map(tenant => tenant.id), env.tenantSchemaBootstrapConcurrency
    ));
    console.log(`[database] ${readyTenants} tenant pronti`);
}

async function initializeBackgroundJobs(): Promise<void> {
    const purge = async () => {
        try {
            const removed = await purgeExpiredRefreshTokens();
            if (removed > 0) console.log(`[auth] rimossi ${removed} refresh token scaduti`);
        } catch (err) {
            console.error('[auth] purge dei refresh token fallita', err);
        }
    };
    await runStartupPhase('expired refresh tokens', purge);
    setInterval(purge, 24 * 60 * 60 * 1000).unref();

    // A fine appuntamento passa a COMPLETED se nessuno ha registrato un esito o
    // una segnalazione esplicita.
    await runStartupPhase('background delivery initialization', async () => {
        startAutomaticAppointmentCompletionSweep();
        startPatientContactReminderSweep();
        if (process.env.REMINDER_EXTERNAL_DELIVERY_ENABLED !== 'false') {
            await startReminderExternalDeliverySweep();
        }
        await startActivityDeliverySweep({initializeExistingTenants: env.databaseMigrationPhase === 'bridge'});
    });
}

bootstrap().catch((err) => {
    console.error('[rehablo-api] failed to start', err);
    process.exit(1);
});

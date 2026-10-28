import billingRoutes from './modules/billing/routes/billing.routes.js';
import {billingWebhook} from './modules/billing/controllers/billing.controller.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import bodyParser from 'body-parser';

import { env } from './config/env.js';
import { connectDatabase, sequelize } from './config/database.js';
import {databaseManifest} from './database/migrationManifest.js';
import {assertDatabaseReady} from './database/releaseControl.js';
import {registerDatabaseModels} from './database/registerModels.js';
import {migrateDatabase} from './database/releaseRunner.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';

import { purgeExpiredRefreshTokens } from './modules/auth/services/refreshToken.service.js';
import { startAutomaticAppointmentCompletionSweep } from './modules/agenda/services/missedArrivalAutomation.service.js';
import {startReminderExternalDeliverySweep} from './modules/notes/services/reminderExternalDelivery.service.js';
import {startPatientContactReminderSweep} from './modules/notes/services/patientContactReminder.service.js';
import {startActivityDeliverySweep} from './modules/activities/services/activityDelivery.service.js';
import activityNotificationsRoutes from './modules/activities/routes/activityNotifications.routes.js';
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
    // Handle Activities before the root-mounted routers for the other domains.
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
    registerDatabaseModels();
    await runStartupPhase('database release migrations', async () => {
        const result = await migrateDatabase(databaseManifest, {
            database: sequelize,
            concurrency: env.migrationConcurrency,
            statementTimeoutMs: env.migrationStatementTimeoutMs,
            reconcileMissingTenants: true,
            onProgress: event => console.log('[database-migration] ' + JSON.stringify({release: databaseManifest.id, ...event}))
        });
        console.log('[database-release] ' + JSON.stringify(result));
    });
    await runStartupPhase('database release compatibility', () => assertDatabaseReady(databaseManifest, sequelize));
    await initializeBackgroundJobs();
}

async function initializeBackgroundJobs(): Promise<void> {
    if (process.env.BACKGROUND_JOBS_ENABLED === 'false') {
        console.log('[startup] background jobs disabled (BACKGROUND_JOBS_ENABLED=false)');
        return;
    }
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
        await startActivityDeliverySweep({initializeExistingTenants: false});
    });
}

bootstrap().catch((err) => {
    console.error('[rehablo-api] failed to start', err);
    process.exit(1);
});

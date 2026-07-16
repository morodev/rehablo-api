import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import bodyParser from 'body-parser';

import { env } from './config/env.js';
import { connectDatabase } from './config/database.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';

import { registerAuthAssociations, syncAuthModels } from './modules/auth/models/index.js';
import { registerTenantModels } from './tenantModelsRegistry.js';
import { registerCatalogAssociations, syncCatalogModels, seedCatalogData } from './modules/human-body/models/catalog/index.js';
import { registerProtocolCatalogAssociations, syncProtocolCatalogModels } from './modules/protocols/models/catalog/index.js';
import { syncMeasurementCatalogModels, seedMeasurementCatalogData } from './modules/measurements/models/catalog/index.js';

import authRoutes from './modules/auth/routes/auth.routes.js';
import patientRoutes from './modules/patients/routes/patient.routes.js';
import productsServicesRoutes from './modules/products-services/routes/products-services.routes.js';
import invoiceRoutes from './modules/invoice/routes/invoice.routes.js';
import agendaRoutes from './modules/agenda/routes/agenda.routes.js';
import configurationRoutes from './modules/configuration/routes/configuration.routes.js';
import humanBodyRoutes from './modules/human-body/routes/human-body.routes.js';
import protocolRoutes from './modules/protocols/routes/protocol.routes.js';
import evaluationRoutes from './modules/evaluations/routes/evaluation.routes.js';
import measurementsRoutes from './modules/measurements/routes/measurements.routes.js';
import maintenanceRoutes from './modules/maintenance/routes/maintenance.routes.js';

async function bootstrap() {
    const app = express();

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
    app.use(bodyParser.urlencoded({ extended: false }));
    app.use(bodyParser.json());

    app.get('/health', (_req, res) => res.json({ status: 'ok' }));

    // Endpoint diagnostico TEMPORANEO per capire se il timeout SMTP è un blocco di rete
    // (Render -> Hostinger) o altro. Da rimuovere una volta risolto il problema email.
    app.get('/debug/smtp-check', async (_req, res) => {
        const net = await import('net');
        const { transporter } = await import('./services/email.service.js');
        const result: Record<string, unknown> = { host: env.emailHost, port: env.emailPort };

        // 1) Connessione TCP grezza (bypassa completamente Nodemailer/TLS)
        const tcpStart = Date.now();
        result.tcp = await new Promise((resolve) => {
            const socket = net.connect({ host: env.emailHost, port: env.emailPort, timeout: 8000 });
            socket.once('connect', () => {
                socket.destroy();
                resolve({ ok: true, ms: Date.now() - tcpStart });
            });
            socket.once('timeout', () => {
                socket.destroy();
                resolve({ ok: false, error: 'ETIMEDOUT (raw TCP)', ms: Date.now() - tcpStart });
            });
            socket.once('error', (err: any) => {
                resolve({ ok: false, error: err?.code || err?.message, ms: Date.now() - tcpStart });
            });
        });

        // 2) Verify completo Nodemailer (TCP + TLS + AUTH)
        const smtpStart = Date.now();
        try {
            await transporter.verify();
            result.smtpVerify = { ok: true, ms: Date.now() - smtpStart };
        } catch (err: any) {
            result.smtpVerify = { ok: false, error: err?.code || err?.message, ms: Date.now() - smtpStart };
        }

        res.json(result);
    });

    // --- Domain routers (every module owns its own URL prefix-free routes, mounted at root) ---
    app.use(authRoutes);
    app.use(patientRoutes);
    app.use(productsServicesRoutes);
    app.use(invoiceRoutes);
    app.use(agendaRoutes);
    app.use(configurationRoutes);
    app.use(humanBodyRoutes);
    app.use(protocolRoutes);
    app.use(evaluationRoutes);
    app.use(measurementsRoutes);
    app.use(maintenanceRoutes);

    app.use(notFoundHandler);
    app.use(errorHandler);

    await connectDatabase();

    // Public-schema models (tenants/users/structures/availabilities)
    registerAuthAssociations();
    await syncAuthModels();

    // Public-schema human-body catalog (standardized scales/tests, shared by every tenant).
    // Seeded exactly once at boot here, instead of on every single GET request like the legacy
    // rehablo-human-body microservice used to do.
    registerCatalogAssociations();
    await syncCatalogModels();
    await seedCatalogData();

    // Public-schema rehabilitation protocols catalog (exercises + reusable protocol templates,
    // shared by every tenant). No seed data yet: managed via the /exercises and /protocol-templates CRUD.
    registerProtocolCatalogAssociations();
    await syncProtocolCatalogModels();

    // Public-schema measurement dictionary (Clinical Data Dictionary): definizioni metriche condivise
    // da tutti i tenant. È il fondamento del modello canonico (docs/REHABLO_OS_GAP_ANALYSIS.md §3).
    await syncMeasurementCatalogModels();
    await seedMeasurementCatalogData();

    // Tenant-scoped models registry (synced lazily per-tenant via ensureTenantSchema)
    registerTenantModels();

    app.listen(env.port, () => {
        console.log(`[rehablo-api] listening on port ${env.port} (${env.nodeEnv})`);
    });
}

bootstrap().catch((err) => {
    console.error('[rehablo-api] failed to start', err);
    process.exit(1);
});

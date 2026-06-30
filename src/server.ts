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

import authRoutes from './modules/auth/routes/auth.routes.js';
import patientRoutes from './modules/patients/routes/patient.routes.js';
import productsServicesRoutes from './modules/products-services/routes/products-services.routes.js';
import invoiceRoutes from './modules/invoice/routes/invoice.routes.js';
import agendaRoutes from './modules/agenda/routes/agenda.routes.js';
import configurationRoutes from './modules/configuration/routes/configuration.routes.js';
import humanBodyRoutes from './modules/human-body/routes/human-body.routes.js';

async function bootstrap() {
    const app = express();

    app.use(helmet());
    app.use(cors({ origin: env.corsOrigin }));
    app.use(morgan(env.isProduction ? 'combined' : 'dev'));
    app.use(bodyParser.urlencoded({ extended: false }));
    app.use(bodyParser.json());

    app.get('/health', (_req, res) => res.json({ status: 'ok' }));

    // --- Domain routers (every module owns its own URL prefix-free routes, mounted at root) ---
    app.use(authRoutes);
    app.use(patientRoutes);
    app.use(productsServicesRoutes);
    app.use(invoiceRoutes);
    app.use(agendaRoutes);
    app.use(configurationRoutes);
    app.use(humanBodyRoutes);

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


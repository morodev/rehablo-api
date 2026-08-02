import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';
import observationController from '../controllers/observation.controller.js';
import importController from '../controllers/import.controller.js';
import importProfileController from '../controllers/importProfile.controller.js';
import deviceController from '../controllers/device.controller.js';
import metricController from '../controllers/metric.controller.js';
import rawFileController from '../controllers/rawFile.controller.js';

const router = Router();

router.use(requireAuth, resolveTenantSchema);

// --- Dizionario metriche (target del mapping wizard) ---
router.get('/metrics', requirePermission('measurement', 'read'), metricController.list);

// --- Lettura ---
router.get('/observations', requirePermission('measurement', 'read'), observationController.list);

// --- Canale ④ Manuale ---
router.post('/observations', requirePermission('measurement', 'create'), observationController.saveManual);

// --- Canale ① Ingestion API (inbound, misure già canoniche) ---
router.post('/v1/observations', requirePermission('measurement', 'create'), observationController.ingestApi);

// --- Canale ③ Import file (CSV) ---
router.get('/device-sources', requirePermission('measurement', 'read'), importController.sources); // sorgenti con mappatura CSV disponibile
router.post('/imports/inspect', requirePermission('measurement', 'create'), importController.inspect); // wizard: colonne + anteprima
router.post('/imports', requirePermission('measurement', 'create'), importController.importCsv);

// --- Mapping wizard: profili di import (mappature come DATO) ---
// I profili sono configurazione condivisa del tenant: la scrittura richiede scope `tenant`.
router.get('/import-profiles', requirePermission('measurement', 'read'), importProfileController.list);
router.get('/import-profiles/:sourceId', requirePermission('measurement', 'read'), importProfileController.getOne);
router.post('/import-profiles', requirePermission('measurement', 'update', 'tenant'), importProfileController.upsert);

// --- Catalogo dispositivi e connessioni ---
router.get('/device-catalog', requirePermission('measurement', 'read'), deviceController.catalog);
router.post('/device-catalog', requirePermission('measurement', 'update', 'tenant'), deviceController.upsertDevice);
router.get('/device-catalog/:sourceId/metrics', requirePermission('measurement', 'read'), deviceController.deviceMetrics);
router.post('/device-connections', requirePermission('measurement', 'create', 'structure'), deviceController.createConnection);
router.get('/device-connections', requirePermission('measurement', 'read'), deviceController.listConnections);

// --- F0.1: RawFile (file grezzo originale di un import/upload) ---
router.post('/raw-files', requirePermission('measurement', 'create'), rawFileController.uploadMiddleware, rawFileController.upload);
router.get('/raw-files/:id/download', requirePermission('measurement', 'read'), rawFileController.download);

export default router;


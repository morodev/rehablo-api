import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
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
router.get('/metrics', metricController.list);

// --- Lettura ---
router.get('/observations', observationController.list);

// --- Canale ④ Manuale ---
router.post('/observations', observationController.saveManual);

// --- Canale ① Ingestion API (inbound, misure già canoniche) ---
router.post('/v1/observations', observationController.ingestApi);

// --- Canale ③ Import file (CSV) ---
router.get('/device-sources', importController.sources); // sorgenti con mappatura CSV disponibile
router.post('/imports/inspect', importController.inspect); // wizard: colonne + anteprima
router.post('/imports', importController.importCsv);

// --- Mapping wizard: profili di import (mappature come DATO) ---
router.get('/import-profiles', importProfileController.list);
router.get('/import-profiles/:sourceId', importProfileController.getOne);
router.post('/import-profiles', importProfileController.upsert);

// --- Catalogo dispositivi e connessioni ---
router.get('/device-catalog', deviceController.catalog);
router.post('/device-catalog', deviceController.upsertDevice);
router.get('/device-catalog/:sourceId/metrics', deviceController.deviceMetrics);
router.post('/device-connections', deviceController.createConnection);
router.get('/device-connections', deviceController.listConnections);

// --- F0.1: RawFile (file grezzo originale di un import/upload) ---
router.post('/raw-files', rawFileController.uploadMiddleware, rawFileController.upload);
router.get('/raw-files/:id/download', rawFileController.download);

export default router;


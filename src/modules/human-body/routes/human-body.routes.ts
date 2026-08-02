import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';

import pointController from '../controllers/point.controller.js';
import areaController from '../controllers/area.controller.js';
import symptomController from '../controllers/symptom.controller.js';
import articularityController from '../controllers/articularity.controller.js';
import strengthController from '../controllers/strength.controller.js';
import questionnaireController from '../controllers/questionnaire.controller.js';
import questionnaireInstanceController from '../controllers/questionnaireInstance.controller.js';
import scaleController from '../controllers/scale.controller.js';
import scaleInstanceController from '../controllers/scaleInstance.controller.js';
import testController from '../controllers/test.controller.js';
import testInstanceController from '../controllers/testInstance.controller.js';

const router = Router();

// Every human-body route requires authentication (replacing the buggy `validToken` reference-without-call
// check from the legacy microservice) and a resolved tenant schema.
// Tutto il modulo è cartella clinica: la risorsa RBAC è `bodymap`, che la segreteria non possiede.
router.use(requireAuth, resolveTenantSchema);

// Points
router.post('/human-body-point', requirePermission('bodymap', 'create'), pointController.createHumanBodyPoint);
router.get('/human-body-point', requirePermission('bodymap', 'read'), pointController.getAllHumanBodyPoints);
router.get('/human-body-point-event', requirePermission('bodymap', 'read'), pointController.getAllHumanBodyPointsWithEvents);
router.get('/human-body-point/:pointId', requirePermission('bodymap', 'read'), pointController.getHumanBodyPointById);
router.delete('/human-body-point/:pointId', requirePermission('bodymap', 'delete'), pointController.deleteHumanBodyPoint);

// Areas
router.post('/human-body-area', requirePermission('bodymap', 'create'), areaController.saveHumanBodyArea);
router.get('/human-body-area', requirePermission('bodymap', 'read'), areaController.getAllHumanBodyAreas);

// Symptoms
router.post('/human-body-symptom', requirePermission('bodymap', 'create'), symptomController.saveSymptom);
router.get('/human-body-symptom', requirePermission('bodymap', 'read'), symptomController.getSymptomById);
router.get('/human-body-symptom-by-point', requirePermission('bodymap', 'read'), symptomController.getAllSymptomByPoint);
router.get('/human-body-symptom-by-body-part', requirePermission('bodymap', 'read'), symptomController.getSymptomsByBodyPart);
router.put('/human-body-symptom/:symptomId', requirePermission('bodymap', 'update'), symptomController.updateSymptom);
router.delete('/human-body-symptom/:symptomId', requirePermission('bodymap', 'delete'), symptomController.deleteSymptom);

// Articularity
router.post('/human-body-articularity', requirePermission('bodymap', 'create'), articularityController.saveArticularity);
router.get('/human-body-articularity-by-point', requirePermission('bodymap', 'read'), articularityController.getAllArticularityByPoint);
router.get('/human-body-articularity-by-body-part', requirePermission('bodymap', 'read'), articularityController.getArticularityByBodyPart);
router.get('/human-body-articularity/:articularityId', requirePermission('bodymap', 'read'), articularityController.getArticularityById);
router.put('/human-body-articularity/:articularityId', requirePermission('bodymap', 'update'), articularityController.updateArticularity);
router.delete('/human-body-articularity/:articularityId', requirePermission('bodymap', 'delete'), articularityController.deleteArticularity);

// Strength
router.post('/human-body-strength', requirePermission('bodymap', 'create'), strengthController.saveStrength);
router.get('/human-body-strength-by-point', requirePermission('bodymap', 'read'), strengthController.getAllStrengthByPoint);
router.get('/human-body-strength-by-body-part', requirePermission('bodymap', 'read'), strengthController.getStrengthByBodyPart);
router.get('/human-body-strength/:strengthId', requirePermission('bodymap', 'read'), strengthController.getStrengthById);
router.put('/human-body-strength/:strengthId', requirePermission('bodymap', 'update'), strengthController.updateStrength);
router.delete('/human-body-strength/:strengthId', requirePermission('bodymap', 'delete'), strengthController.deleteStrength);

// Custom (per-tenant) questionnaires: la definizione del questionario è configurazione
// condivisa del tenant, la compilazione (instance) è un atto clinico sul paziente.
router.post('/questionnaire', requirePermission('bodymap', 'create', 'structure'), questionnaireController.saveQuestionnaire);
router.get('/questionnaires', requirePermission('bodymap', 'read'), questionnaireController.getAllQuestionnaires);
router.get('/questionnaires/search', requirePermission('bodymap', 'read'), questionnaireController.searchQuestionnaires);
router.put('/questionnaire/:questionnaireId', requirePermission('bodymap', 'update', 'structure'), questionnaireController.updateQuestionnaireById);
router.delete('/questionnaire/:questionnaireId', requirePermission('bodymap', 'delete', 'structure'), questionnaireController.deleteQuestionnaireById);
router.get('/questionnaire/:questionnaireId', requirePermission('bodymap', 'read'), questionnaireController.getQuestionnaireById);
router.post('/questionnaire-instance', requirePermission('bodymap', 'create'), questionnaireInstanceController.saveQuestionnaireInstance);
router.get('/questionnaire-instance', requirePermission('bodymap', 'read'), questionnaireInstanceController.getQuestionnaireInstances);
router.get('/questionnaire-instance-by-point', requirePermission('bodymap', 'read'), questionnaireInstanceController.getQuestionnaireInstancesByPoint);

// Standardized scales catalog (public schema) + per-tenant compiled instances
router.get('/scales', requirePermission('evaluation', 'read'), scaleController.getAllScales);
router.get('/scales/search', requirePermission('evaluation', 'read'), scaleController.searchScales);
router.post('/scales-instance', requirePermission('evaluation', 'create'), scaleInstanceController.saveScale);
router.get('/scales-instance', requirePermission('evaluation', 'read'), scaleInstanceController.getUserScaleInstances);

// Standardized clinical/orthopedic tests catalog (public schema) + per-tenant compiled instances
router.get('/tests', requirePermission('evaluation', 'read'), testController.getAllTests);
router.get('/tests-orthopedic', requirePermission('evaluation', 'read'), testController.getAllOrthopedicTests);
router.get('/tests-clinic', requirePermission('evaluation', 'read'), testController.getAllClinicTests);
router.get('/tests/search', requirePermission('evaluation', 'read'), testController.searchTests);
router.post('/tests-instance', requirePermission('evaluation', 'create'), testInstanceController.saveTest);
router.get('/tests-instance', requirePermission('evaluation', 'read'), testInstanceController.getUserTestInstances);

export default router;



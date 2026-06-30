import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
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
router.use(requireAuth, resolveTenantSchema);

// Points
router.post('/human-body-point', pointController.createHumanBodyPoint);
router.get('/human-body-point', pointController.getAllHumanBodyPoints);
router.get('/human-body-point-event', pointController.getAllHumanBodyPointsWithEvents);
router.get('/human-body-point/:pointId', pointController.getHumanBodyPointById);
router.delete('/human-body-point/:pointId', pointController.deleteHumanBodyPoint);

// Areas
router.post('/human-body-area', areaController.saveHumanBodyArea);
router.get('/human-body-area', areaController.getAllHumanBodyAreas);

// Symptoms
router.post('/human-body-symptom', symptomController.saveSymptom);
router.get('/human-body-symptom', symptomController.getSymptomById);
router.get('/human-body-symptom-by-point', symptomController.getAllSymptomByPoint);
router.get('/human-body-symptom-by-body-part', symptomController.getSymptomsByBodyPart);
router.put('/human-body-symptom/:symptomId', symptomController.updateSymptom);
router.delete('/human-body-symptom/:symptomId', symptomController.deleteSymptom);

// Articularity
router.post('/human-body-articularity', articularityController.saveArticularity);
router.get('/human-body-articularity-by-point', articularityController.getAllArticularityByPoint);
router.get('/human-body-articularity-by-body-part', articularityController.getArticularityByBodyPart);
router.get('/human-body-articularity/:articularityId', articularityController.getArticularityById);
router.put('/human-body-articularity/:articularityId', articularityController.updateArticularity);
router.delete('/human-body-articularity/:articularityId', articularityController.deleteArticularity);

// Strength
router.post('/human-body-strength', strengthController.saveStrength);
router.get('/human-body-strength-by-point', strengthController.getAllStrengthByPoint);
router.get('/human-body-strength-by-body-part', strengthController.getStrengthByBodyPart);
router.get('/human-body-strength/:strengthId', strengthController.getStrengthById);
router.put('/human-body-strength/:strengthId', strengthController.updateStrength);
router.delete('/human-body-strength/:strengthId', strengthController.deleteStrength);

// Custom (per-tenant) questionnaires
router.post('/questionnaire', questionnaireController.saveQuestionnaire);
router.get('/questionnaires', questionnaireController.getAllQuestionnaires);
router.get('/questionnaires/search', questionnaireController.searchQuestionnaires);
router.put('/questionnaire/:questionnaireId', questionnaireController.updateQuestionnaireById);
router.delete('/questionnaire/:questionnaireId', questionnaireController.deleteQuestionnaireById);
router.get('/questionnaire/:questionnaireId', questionnaireController.getQuestionnaireById);
router.post('/questionnaire-instance', questionnaireInstanceController.saveQuestionnaireInstance);
router.get('/questionnaire-instance', questionnaireInstanceController.getQuestionnaireInstances);

// Standardized scales catalog (public schema) + per-tenant compiled instances
router.get('/scales', scaleController.getAllScales);
router.get('/scales/search', scaleController.searchScales);
router.post('/scales-instance', scaleInstanceController.saveScale);
router.get('/scales-instance', scaleInstanceController.getUserScaleInstances);

// Standardized clinical/orthopedic tests catalog (public schema) + per-tenant compiled instances
router.get('/tests', testController.getAllTests);
router.get('/tests-orthopedic', testController.getAllOrthopedicTests);
router.get('/tests-clinic', testController.getAllClinicTests);
router.get('/tests/search', testController.searchTests);
router.post('/tests-instance', testInstanceController.saveTest);
router.get('/tests-instance', testInstanceController.getUserTestInstances);

export default router;



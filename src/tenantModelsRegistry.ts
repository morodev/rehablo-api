import { registerTenantScopedModel } from './utils/tenantSchema.js';

import Patient from './modules/patients/models/patient.model.js';
import { registerProductsServicesAssociations, Category, Product, Service } from './modules/products-services/models/index.js';
import { registerInvoiceAssociations, Invoice, InvoiceProduct, InvoiceService } from './modules/invoice/models/index.js';
import EventType from './modules/agenda/models/eventType.model.js';
import AgendaEvent from './modules/agenda/models/agendaEvent.model.js';
import AgendaEventException from './modules/agenda/models/agendaEventException.model.js';
import { registerConfigurationAssociations, Dashboard, Widget } from './modules/configuration/models/index.js';
import { registerProtocolAssociations, ProtocolInstance, ProtocolPhaseInstance, ProtocolExerciseLog } from './modules/protocols/models/index.js';
import {
    registerHumanBodyAssociations,
    HumanBodyArea,
    HumanBodyPoint,
    HumanBodyEvent,
    HumanBodySymptom,
    HumanBodyArticularity,
    HumanBodyStrength,
    HumanBodyQuestionnaire,
    HumanBodyQuestion,
    HumanBodyAnswer,
    HumanBodyQuestionnaireInstance,
    HumanBodyAnswerInstance,
    UserScaleInstance,
    UserAnswer,
    TestInstance
} from './modules/human-body/models/index.js';
import { registerEvaluationAssociations, Evaluation } from './modules/evaluations/models/index.js';
import { registerMeasurementAssociations, Observation, DeviceConnection, RawFile } from './modules/measurements/models/index.js';

/**
 * Registers every tenant-scoped model (i.e. living in the dynamic "rehablo_<tenantId>" schema)
 * so that `ensureTenantSchema()` can sync them automatically the first time a tenant is touched.
 */
export function registerTenantModels(): void {
    registerHumanBodyAssociations();
    registerProtocolAssociations();
    // Must run after `registerHumanBodyAssociations()`: it adds the `Evaluation` -> symptoms/
    // articularities/strengths/questionnaires/scales/tests associations on top of those models.
    registerEvaluationAssociations();
    registerProductsServicesAssociations();
    registerInvoiceAssociations();
    registerConfigurationAssociations();
    registerMeasurementAssociations();

    registerTenantScopedModel(Patient);
    // Evaluation references `patients` (FK) and is in turn referenced by the human-body instance
    // tables below (FK), so it must be synced right after Patient and before those tables.
    registerTenantScopedModel(Evaluation);
    // Observation (misure canoniche): riferisce patientId/metricCode come colonne logiche, nessuna
    // FK cross-schema, quindi l'ordine relativo non è vincolante.
    registerTenantScopedModel(Observation);
    // DeviceConnection (connessioni ai dispositivi del centro, con credenziali cifrate).
    registerTenantScopedModel(DeviceConnection);
    // RawFile (F0.1): file grezzo originale di un import/upload. `Observation.rawFileId` lo referenzia
    // in modo logico; nessun vincolo di ordine di sync richiesto (nessuna FK cross-tabella reale).
    registerTenantScopedModel(RawFile);
    registerTenantScopedModel(Category);
    registerTenantScopedModel(Product);
    registerTenantScopedModel(Service);
    registerTenantScopedModel(Invoice);
    registerTenantScopedModel(InvoiceProduct);
    registerTenantScopedModel(InvoiceService);
    registerTenantScopedModel(EventType);
    registerTenantScopedModel(AgendaEvent);
    registerTenantScopedModel(AgendaEventException);
    registerTenantScopedModel(Dashboard);
    registerTenantScopedModel(Widget);

    registerTenantScopedModel(ProtocolInstance);
    registerTenantScopedModel(ProtocolPhaseInstance);
    registerTenantScopedModel(ProtocolExerciseLog);

    registerTenantScopedModel(HumanBodyArea);
    registerTenantScopedModel(HumanBodyPoint);
    registerTenantScopedModel(HumanBodyEvent);
    registerTenantScopedModel(HumanBodySymptom);
    registerTenantScopedModel(HumanBodyArticularity);
    registerTenantScopedModel(HumanBodyStrength);
    registerTenantScopedModel(HumanBodyQuestionnaire);
    registerTenantScopedModel(HumanBodyQuestion);
    registerTenantScopedModel(HumanBodyAnswer);
    registerTenantScopedModel(HumanBodyQuestionnaireInstance);
    registerTenantScopedModel(HumanBodyAnswerInstance);
    registerTenantScopedModel(UserScaleInstance);
    registerTenantScopedModel(UserAnswer);
    registerTenantScopedModel(TestInstance);
}

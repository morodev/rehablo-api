import { registerTenantScopedModel } from './utils/tenantSchema.js';

import Patient from './modules/patients/models/patient.model.js';
import { registerProductsServicesAssociations, Category, Product, Service } from './modules/products-services/models/index.js';
import Invoice from './modules/invoice/models/invoice.model.js';
import InvoiceProduct from './modules/invoice/models/invoiceProduct.model.js';
import InvoiceService from './modules/invoice/models/invoiceService.model.js';
import EventType from './modules/agenda/models/eventType.model.js';
import AgendaEvent from './modules/agenda/models/agendaEvent.model.js';
import AgendaEventException from './modules/agenda/models/agendaEventException.model.js';
import Dashboard from './modules/configuration/models/dashboard.model.js';
import Widget from './modules/configuration/models/widget.model.js';
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

    registerTenantScopedModel(Patient);
    // Evaluation references `patients` (FK) and is in turn referenced by the human-body instance
    // tables below (FK), so it must be synced right after Patient and before those tables.
    registerTenantScopedModel(Evaluation);
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

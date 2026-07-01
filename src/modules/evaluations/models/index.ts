import Evaluation from './evaluation.model.js';
import Patient from '../../patients/models/patient.model.js';
import {
    HumanBodySymptom,
    HumanBodyArticularity,
    HumanBodyStrength,
    HumanBodyQuestionnaireInstance,
    HumanBodyAnswerInstance,
    HumanBodyQuestionnaire,
    HumanBodyQuestion,
    HumanBodyAnswer,
    UserScaleInstance,
    UserAnswer,
    TestInstance
} from '../../human-body/models/index.js';
import { Scale, QuestionScale, AnswerScale, Test } from '../../human-body/models/catalog/index.js';

/**
 * Centralised associations for the "evaluations" tenant-scoped models (dynamic "rehablo_<tenantId>" schema).
 *
 * An `Evaluation` is the aggregate root that groups together everything gathered during a single
 * clinical assessment session for a patient: symptoms, articularities, strengths, compiled
 * questionnaires, compiled scales and tests. Every one of those human-body sub-models gets an
 * optional `evaluationId` foreign key pointing back here.
 */
export function registerEvaluationAssociations(): void {
    // An evaluation always belongs to a patient.
    Patient.hasMany(Evaluation, { foreignKey: { name: 'patientId', allowNull: false }, onDelete: 'cascade', hooks: true });
    Evaluation.belongsTo(Patient, { foreignKey: { name: 'patientId', allowNull: false } });

    Evaluation.hasMany(HumanBodySymptom, { foreignKey: 'evaluationId', onDelete: 'cascade', hooks: true });
    HumanBodySymptom.belongsTo(Evaluation, { foreignKey: 'evaluationId' });

    Evaluation.hasMany(HumanBodyArticularity, { foreignKey: 'evaluationId', onDelete: 'cascade', hooks: true });
    HumanBodyArticularity.belongsTo(Evaluation, { foreignKey: 'evaluationId' });

    Evaluation.hasMany(HumanBodyStrength, { foreignKey: 'evaluationId', onDelete: 'cascade', hooks: true });
    HumanBodyStrength.belongsTo(Evaluation, { foreignKey: 'evaluationId' });

    Evaluation.hasMany(HumanBodyQuestionnaireInstance, { foreignKey: 'evaluationId', onDelete: 'cascade', hooks: true });
    HumanBodyQuestionnaireInstance.belongsTo(Evaluation, { foreignKey: 'evaluationId' });

    Evaluation.hasMany(UserScaleInstance, { foreignKey: 'evaluationId', onDelete: 'cascade', hooks: true });
    UserScaleInstance.belongsTo(Evaluation, { foreignKey: 'evaluationId' });

    Evaluation.hasMany(TestInstance, { foreignKey: 'evaluationId', onDelete: 'cascade', hooks: true });
    TestInstance.belongsTo(Evaluation, { foreignKey: 'evaluationId' });
}

export {
    Evaluation,
    HumanBodySymptom,
    HumanBodyArticularity,
    HumanBodyStrength,
    HumanBodyQuestionnaireInstance,
    HumanBodyAnswerInstance,
    HumanBodyQuestionnaire,
    HumanBodyQuestion,
    HumanBodyAnswer,
    UserScaleInstance,
    UserAnswer,
    TestInstance,
    Scale,
    QuestionScale,
    AnswerScale,
    Test
};


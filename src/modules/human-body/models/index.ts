import HumanBodyArea from './humanBodyArea.model.js';
import HumanBodyPoint from './humanBodyPoint.model.js';
import HumanBodyEvent from './humanBodyEvent.model.js';
import HumanBodySymptom from './humanBodySymptom.model.js';
import HumanBodyArticularity from './humanBodyArticularity.model.js';
import HumanBodyStrength from './humanBodyStrength.model.js';
import HumanBodyQuestionnaire from './humanBodyQuestionnaire.model.js';
import HumanBodyQuestion from './humanBodyQuestion.model.js';
import HumanBodyAnswer from './humanBodyAnswer.model.js';
import HumanBodyQuestionnaireInstance from './humanBodyQuestionnaireInstance.model.js';
import HumanBodyAnswerInstance from './humanBodyAnswerInstance.model.js';
import UserScaleInstance from './userScaleInstance.model.js';
import UserAnswer from './userAnswer.model.js';
import TestInstance from './testInstance.model.js';
import { Scale, QuestionScale, AnswerScale, Test } from './catalog/index.js';

/**
 * Centralised associations for the human-body tenant-scoped models (dynamic "rehablo_<tenantId>" schema).
 * Mirrors what the former rehablo-human-body microservice declared ad-hoc (and inconsistently) inside
 * each controller before every single request.
 */
export function registerHumanBodyAssociations(): void {
    HumanBodyPoint.hasMany(HumanBodyEvent, { onDelete: 'cascade', foreignKey: { allowNull: false }, hooks: true });
    HumanBodyEvent.belongsTo(HumanBodyPoint, { onDelete: 'cascade', foreignKey: { allowNull: false }, hooks: true });

    HumanBodyPoint.hasMany(HumanBodySymptom, { onDelete: 'cascade', foreignKey: { allowNull: false }, hooks: true });
    HumanBodySymptom.belongsTo(HumanBodyPoint, { onDelete: 'cascade', foreignKey: { allowNull: false }, hooks: true });

    HumanBodyPoint.hasMany(HumanBodyArticularity, { onDelete: 'cascade', foreignKey: { allowNull: false }, hooks: true });
    HumanBodyArticularity.belongsTo(HumanBodyPoint, { onDelete: 'cascade', foreignKey: { allowNull: false }, hooks: true });

    HumanBodyPoint.hasMany(HumanBodyStrength, { onDelete: 'cascade', foreignKey: { allowNull: false }, hooks: true });
    HumanBodyStrength.belongsTo(HumanBodyPoint, { onDelete: 'cascade', foreignKey: { allowNull: false }, hooks: true });

    HumanBodyArea.hasMany(HumanBodySymptom);
    HumanBodySymptom.belongsTo(HumanBodyArea);

    HumanBodyQuestionnaire.hasMany(HumanBodyQuestion, { foreignKey: 'humanBodyQuestionnaireId' });
    HumanBodyQuestion.belongsTo(HumanBodyQuestionnaire, { foreignKey: 'humanBodyQuestionnaireId' });

    HumanBodyQuestion.hasMany(HumanBodyAnswer, { foreignKey: 'humanBodyQuestionId' });
    HumanBodyAnswer.belongsTo(HumanBodyQuestion, { foreignKey: 'humanBodyQuestionId' });

    HumanBodyQuestionnaire.hasMany(HumanBodyQuestionnaireInstance, { foreignKey: 'humanBodyQuestionnaireId' });
    HumanBodyQuestionnaireInstance.belongsTo(HumanBodyQuestionnaire, { foreignKey: 'humanBodyQuestionnaireId' });

    HumanBodyQuestionnaireInstance.hasMany(HumanBodyAnswerInstance, { foreignKey: 'humanBodyQuestionnaireInstanceId' });
    HumanBodyAnswerInstance.belongsTo(HumanBodyQuestionnaireInstance, { foreignKey: 'humanBodyQuestionnaireInstanceId' });
    HumanBodyAnswerInstance.belongsTo(HumanBodyQuestion, { foreignKey: 'humanBodyQuestionId' });
    HumanBodyAnswerInstance.belongsTo(HumanBodyAnswer, { foreignKey: 'humanBodyAnswerId' });

    UserScaleInstance.hasMany(UserAnswer, { foreignKey: 'userScaleInstanceId' });
    UserAnswer.belongsTo(UserScaleInstance, { foreignKey: 'userScaleInstanceId' });

    // Cross-schema associations: tenant-scoped instances reference the public-schema catalog.
    UserScaleInstance.belongsTo(Scale, { foreignKey: 'scaleId', constraints: false });
    UserAnswer.belongsTo(QuestionScale, { foreignKey: 'questionScaleId', constraints: false });
    UserAnswer.belongsTo(AnswerScale, { foreignKey: 'answerScaleId', constraints: false });

    TestInstance.belongsTo(Test, { foreignKey: 'testId', constraints: false });
}

export {
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
};



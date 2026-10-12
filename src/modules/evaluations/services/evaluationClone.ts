import type { ModelStatic, Model } from 'sequelize';
import { Transaction } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import Evaluation from '../models/evaluation.model.js';
import HumanBodyEvent from '../../human-body/models/humanBodyEvent.model.js';
import Observation from '../../measurements/models/observation.model.js';
import {
    HumanBodyPoint,
    HumanBodySymptom,
    HumanBodyArticularity,
    HumanBodyStrength,
    HumanBodyQuestionnaireInstance,
    HumanBodyAnswerInstance,
    UserScaleInstance,
    UserAnswer,
    TestInstance
} from '../models/index.js';

export interface CloneContext {
    userId: string;
}

/** Copia una riga: rimuove id/timestamps, applica una trasformazione e crea la nuova riga. */
async function copyRow(
    model: ModelStatic<Model>,
    schema: string,
    transaction: Transaction,
    row: Model,
    transform: (plain: Record<string, any>) => void
): Promise<Model> {
    const plain = row.get({ plain: true }) as Record<string, any>;
    delete plain.id;
    delete plain.createdAt;
    delete plain.updatedAt;
    transform(plain);
    return model.schema(schema).create(plain as any, { transaction });
}

/**
 * "Duplica in nuova valutazione" (FASE E). Crea una nuova `Evaluation` DRAFT (data = oggi,
 * `parentEvaluationId` = sorgente) e ne duplica TUTTI i sotto-record con nuovi id, rimappando i
 * riferimenti ai punti (i punti clonati hanno id nuovi). L'originale resta immutata.
 */
export async function cloneEvaluation(schema: string, sourceId: string, ctx: CloneContext, transaction?: Transaction): Promise<Evaluation> {
    if (!transaction) {
        return sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
            transaction => cloneEvaluation(schema, sourceId, ctx, transaction));
    }
    const source = await Evaluation.schema(schema).findByPk(sourceId, { transaction });
    if (!source) {
        const err = new Error('Valutazione non trovata') as Error & { statusCode: number };
        err.statusCode = 404;
        throw err;
    }

    const sourceTitle = source.get('title') as string | null;
    const newEvaluation = await Evaluation.schema(schema).create({
        patientId: source.get('patientId') as string,
        userId: ctx.userId,
        structureId: (source.get('structureId') as string | null) ?? null,
        date: new Date(),
        title: sourceTitle ? `Copia di ${sourceTitle}` : null,
        notes: (source.get('notes') as string | null) ?? null,
        status: 'DRAFT',
        parentEvaluationId: sourceId
    }, { transaction });
    const newEvaluationId = newEvaluation.get('id') as string;

    // --- Punti (con rimappatura id) + eventi del punto ---
    const points = await HumanBodyPoint.schema(schema).findAll({ where: { evaluationId: sourceId }, transaction });
    const pointIdMap: Record<string, string> = {};
    for (const point of points) {
        const oldId = point.get('id') as string;
        const newPoint = await copyRow(HumanBodyPoint as any, schema, transaction, point, (p) => {
            p.evaluationId = newEvaluationId;
        });
        const newId = newPoint.get('id') as string;
        pointIdMap[oldId] = newId;

        const events = await HumanBodyEvent.schema(schema).findAll({ where: { humanBodyPointId: oldId }, transaction });
        for (const event of events) {
            await copyRow(HumanBodyEvent as any, schema, transaction, event, (e) => {
                e.humanBodyPointId = newId;
            });
        }
    }

    const remapPoint = (plain: Record<string, any>) => {
        if (plain.humanBodyPointId && pointIdMap[plain.humanBodyPointId]) {
            plain.humanBodyPointId = pointIdMap[plain.humanBodyPointId];
        }
    };

    // --- Sotto-record semplici agganciati al punto ---
    for (const model of [HumanBodySymptom, HumanBodyArticularity, HumanBodyStrength]) {
        const rows = await (model as any).schema(schema).findAll({ where: { evaluationId: sourceId }, transaction });
        for (const row of rows) {
            await copyRow(model as any, schema, transaction, row, (p) => {
                p.evaluationId = newEvaluationId;
                remapPoint(p);
            });
        }
    }

    // --- Questionari compilati + risposte (rimappa il parent instance id) ---
    const questionnaireInstances = await HumanBodyQuestionnaireInstance.schema(schema).findAll({
        where: { evaluationId: sourceId }, transaction
    });
    for (const qi of questionnaireInstances) {
        const oldId = qi.get('id') as string;
        const newQi = await copyRow(HumanBodyQuestionnaireInstance as any, schema, transaction, qi, (p) => {
            p.evaluationId = newEvaluationId;
            remapPoint(p);
        });
        const newId = newQi.get('id') as string;
        const answers = await HumanBodyAnswerInstance.schema(schema).findAll({
            where: { humanBodyQuestionnaireInstanceId: oldId }, transaction
        });
        for (const answer of answers) {
            await copyRow(HumanBodyAnswerInstance as any, schema, transaction, answer, (p) => {
                p.humanBodyQuestionnaireInstanceId = newId;
            });
        }
    }

    // --- Scale compilate + risposte ---
    const scaleInstances = await UserScaleInstance.schema(schema).findAll({ where: { evaluationId: sourceId }, transaction });
    for (const si of scaleInstances) {
        const oldId = si.get('id') as string;
        const newSi = await copyRow(UserScaleInstance as any, schema, transaction, si, (p) => {
            p.evaluationId = newEvaluationId;
        });
        const newId = newSi.get('id') as string;
        const answers = await UserAnswer.schema(schema).findAll({ where: { userScaleInstanceId: oldId }, transaction });
        for (const answer of answers) {
            await copyRow(UserAnswer as any, schema, transaction, answer, (p) => {
                p.userScaleInstanceId = newId;
            });
        }
    }

    // --- Test ortopedici ---
    const testInstances = await TestInstance.schema(schema).findAll({ where: { evaluationId: sourceId }, transaction });
    for (const ti of testInstances) {
        await copyRow(TestInstance as any, schema, transaction, ti, (p) => {
            p.evaluationId = newEvaluationId;
        });
    }

    // --- Observation (device/CSV/manuale) ---
    const observations = await Observation.schema(schema).findAll({ where: { evaluationId: sourceId }, transaction });
    for (const obs of observations) {
        await copyRow(Observation as any, schema, transaction, obs, (p) => {
            p.evaluationId = newEvaluationId;
            remapPoint(p);
        });
    }

    return newEvaluation;
}


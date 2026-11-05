import {testInstanceDto} from '../../human-body/services/testSnapshot.js';
import {assertClinicalEvaluationRead,visibleClinicalEvaluations,clinicalEvaluationCapabilities} from '../services/clinicalReadGuard.js';
import {assertClinicalWriteContext,clinicalInputError} from '../services/clinicalWriteGuard.js';
import { assertClinicalEvaluationContext } from '../../clinical/services/clinical.service.js';
import { Request, Response } from 'express';
import { Transaction } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import {resolveGrantedScope} from '../../auth/rbac/permissions.js';
import { scopeWhere, getGrantedPermissions } from '../../../middleware/rbac.js';
import Patient from '../../patients/models/patient.model.js';
import Observation from '../../measurements/models/observation.model.js';
import { assertEvaluationEditable, assertNotFutureDate, evaluationCapabilities } from '../services/evaluationGuard.js';
import { cloneEvaluation } from '../services/evaluationClone.js';
import { boundedInteger, normalizeSearchQuery } from '../../../utils/search.js';
import { Op } from 'sequelize';
import {
    Evaluation,
    HumanBodyPoint,
    HumanBodyArea,
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
} from '../models/index.js';

/**
 * Campi per il filtro row-level RBAC: `userId` è il professionista autore della valutazione,
 * `structureId` la sede in cui è stata prodotta (nullable finché non si fa il backfill).
 */
const EVALUATION_SCOPE_FIELDS = {
    ownerField: 'userId',
    structureField: 'structureId',
    includeUnassigned: false
};

/**
 * Creates a new evaluation ("valutazione") for a patient. Symptoms, questionnaires, scales and
 * tests are added afterwards by their own endpoints, passing back this evaluation's `id` as
 * `evaluationId`.
 */
export const createEvaluation = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { patientId, date, title, notes, status, structureId } = req.body as {
        patientId?: string;
        date?: string;
        title?: string;
        notes?: string;
        status?: 'DRAFT' | 'COMPLETED';
        structureId?: string;
    };

    if (!patientId) {
        return sendErrorResponse(res, 400, 'patientId is required');
    }

    // FASE E: la data della valutazione non può essere futura (solo oggi o nel passato).
    assertNotFutureDate(date);

    // Si può creare una valutazione solo su un paziente che si ha il diritto di vedere.
    const evaluation=await sequelize.transaction(async transaction=>{
    const patient = await Patient.schema(schema).findOne({
        where: {
            id: patientId,
            structureId: req.access?.structureId ?? null,
            archivedAt: null
        },transaction,lock:transaction.LOCK.SHARE
    });
    if (!patient) {
        throw clinicalInputError('Paziente non trovato',404);
    }

    // Se la struttura non è indicata esplicitamente per questa valutazione, si ricade sulla
    // struttura di riferimento anagrafico del paziente (necessaria per instradare correttamente
    // un futuro invio al FSE regionale in base alla Regione della struttura).
    const resolvedStructureId = patient.get('structureId') as string;

    const clinicalContext=await assertClinicalEvaluationContext(req,{carePathId:req.body.carePathId,patientId,templateVersionId:req.body.templateVersionId},transaction);
    return Evaluation.schema(schema).create({
        patientId,
        userId: req.user!.id,
        structureId: resolvedStructureId,
        ...(req.body.carePathId?{carePathId:req.body.carePathId,templateVersionId:req.body.templateVersionId??null,configurationSnapshot:clinicalContext?.configurationSnapshot??null,clinicalVisibility:clinicalContext?.clinicalVisibility??'CLINICAL'}:{}),
        date: date ? new Date(date) : new Date(),
        title: title ?? null,
        notes: notes ?? null,
        // FASE E: una nuova valutazione nasce come DRAFT (in lavorazione) e diventa COMPLETED solo con
        // "Salva e chiudi". Prima era COMPLETED di default (flusso legacy senza ciclo di vita).
        status: status ?? 'DRAFT'
    },{transaction});
    });

    return sendSuccessResponse(res, 201, {...evaluation.get({plain:true}),capabilities:await clinicalEvaluationCapabilities(req,evaluation)}, 'Valutazione creata correttamente');
});

/** Lists the evaluations of a patient (or of the whole tenant if `patientId` is omitted), most recent first. */
export const getEvaluations = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { patientId, status, query } = req.query as { patientId?: string; status?: string; query?: string };
    const normalized = normalizeSearchQuery(query);
    const limit = boundedInteger(req.query.limit, 1000, 1, 1000);

    let evaluations = await Evaluation.schema(schema).findAll({
        where: {
            ...(patientId ? { patientId } : {}),
            ...(status ? { status } : {}),
            ...scopeWhere(req, EVALUATION_SCOPE_FIELDS)
        },
        order: [['date', 'DESC']],
        // Con una ricerca il limite va applicato dopo il filtro su paziente e titolo, altrimenti
        // una corrispondenza storica potrebbe sparire solo perché non è fra le ultime righe.
        limit: normalized ? undefined : limit
    });

    evaluations=await visibleClinicalEvaluations(req,evaluations);
    const patientIds = [...new Set(evaluations.map((evaluation) => evaluation.patientId))];
    const patients = patientIds.length
        ? await Patient.schema(schema).findAll({
            where: { id: { [Op.in]: patientIds }, archivedAt: null },
            attributes: ['id', 'name', 'surname', 'fiscalCode'],
            raw: true
        })
        : [];
    const patientsById = new Map(patients.map((patient: any) => [patient.id, patient]));
    const tokens = normalized ? normalized.split(' ') : [];
    const mapped = await Promise.all(evaluations
        .map(async (evaluation): Promise<Record<string, any>> => {
            const plain = evaluation.get({ plain: true }) as Record<string, any>;
            return { ...plain, patient: patientsById.get(plain.patientId) ?? null, capabilities:await clinicalEvaluationCapabilities(req,evaluation) };
        }));
    const result = mapped
        .filter((evaluation) => {
            if (!tokens.length) return true;
            const haystack = normalizeSearchQuery([
                evaluation.title,
                evaluation.patient?.name,
                evaluation.patient?.surname,
                evaluation.patient?.fiscalCode
            ].filter(Boolean).join(' '));
            return tokens.every((token) => haystack.includes(token));
        })
        .slice(0, limit);

    return sendSuccessResponse(res, 200, result, 'Valutazioni caricate correttamente');
});

/** Full detail of a single evaluation: every symptom/articularity/strength/questionnaire/scale/test attached to it. */
export const getEvaluationById = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { evaluationId } = req.params;

    const evaluation = await Evaluation.schema(schema).findOne({
        where: { id: evaluationId, ...scopeWhere(req, EVALUATION_SCOPE_FIELDS) },
        include: [
            { model: HumanBodyPoint.schema(schema) },
            { model: HumanBodyArea.schema(schema) },
            { model: HumanBodySymptom.schema(schema) },
            { model: HumanBodyArticularity.schema(schema) },
            { model: HumanBodyStrength.schema(schema) },
            {
                model: HumanBodyQuestionnaireInstance.schema(schema),
                include: [
                    { model: HumanBodyQuestionnaire.schema(schema), attributes: ['title', 'description'] },
                    {
                        model: HumanBodyAnswerInstance.schema(schema),
                        as: 'answers',
                        include: [
                            { model: HumanBodyQuestion.schema(schema), as: 'question', attributes: ['text'] },
                            { model: HumanBodyAnswer.schema(schema), as: 'answer', attributes: ['text', 'isCorrect'] }
                        ]
                    }
                ]
            },
            {
                model: UserScaleInstance.schema(schema),
                include: [
                    { model: Scale, attributes: ['name', 'description', 'isFullBody'] },
                    {
                        model: UserAnswer.schema(schema),
                        include: [
                            { model: QuestionScale, attributes: ['description'] },
                            { model: AnswerScale, attributes: ['description', 'value'] }
                        ]
                    }
                ]
            },
            { model: TestInstance.schema(schema), include: [{ model: Test, required: false }] }
        ]
    });

    if (!evaluation) {
        return sendErrorResponse(res, 404, 'Valutazione non trovata');
    }

    await assertClinicalEvaluationRead(req,evaluation);
    // Le Observation (misure device/CSV/manuale) vivono nel modulo measurements: le carichiamo con
    // una query separata per `evaluationId` invece di un'associazione cross-modulo, e le agganciamo
    // alla risposta come `observations` (FASE E).
    const observations = await Observation.schema(schema).findAll({
        where: { evaluationId },
        order: [['effectiveDateTime', 'DESC']]
    });

    const plain=evaluation.get({plain:true}) as Record<string,any>;
    if(Array.isArray(plain.testInstances))plain.testInstances=plain.testInstances.map(testInstanceDto);
    const payload = { ...plain, observations, capabilities:await clinicalEvaluationCapabilities(req,evaluation) };
    return sendSuccessResponse(res, 200, payload, 'Valutazione caricata correttamente');
});

export const updateEvaluation = asyncHandler(async (req: Request, res: Response) => {
    const schema=req.tenantSchema!;
    const result=await sequelize.transaction(async transaction=>{
        const evaluation=await Evaluation.schema(schema).findOne({where:{id:req.params.evaluationId,...scopeWhere(req,EVALUATION_SCOPE_FIELDS)},transaction,lock:transaction.LOCK.UPDATE});
        if(!evaluation) return null;
        await assertClinicalWriteContext(req,{patientId:evaluation.patientId,evaluationId:evaluation.id},transaction);
        assertNotFutureDate(req.body?.date);
        if(req.body.status!==undefined && !['DRAFT','COMPLETED'].includes(req.body.status)) return {invalid:true} as const;
        const payload=Object.fromEntries(['date','title','notes','status'].filter(field=>Object.prototype.hasOwnProperty.call(req.body??{},field)).map(field=>[field,req.body[field]]));
        if(!Object.keys(payload).length) return {invalid:true} as const;
        await evaluation.update(payload,{transaction});
        return evaluation;
    });
    if(!result) return sendErrorResponse(res,404,'Valutazione non trovata');
    if('invalid' in result) return sendErrorResponse(res,400,'Campi della valutazione non validi');
    return sendSuccessResponse(res,200,{...result.get({plain:true}),capabilities:await clinicalEvaluationCapabilities(req,result)},'Valutazione aggiornata');
});

/**
 * "Duplica in nuova valutazione" (FASE E): crea una nuova valutazione DRAFT derivata dalla sorgente,
 * copiando tutti i sotto-record (punti, sintomi, ROM, forza, questionari, scale, test, observations)
 * con nuovi id. Serve a modificare i dati senza alterare la valutazione originale (immutabile).
 */
export const cloneEvaluationHandler = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const sourceId = req.params.evaluationId;

    // Si può duplicare solo una valutazione che si ha il diritto di vedere.
    const created = await sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ }, async transaction => {
        const source = await Evaluation.schema(schema).findOne({
            where: { id: sourceId, ...scopeWhere(req, EVALUATION_SCOPE_FIELDS) }, transaction
        });
        if (!source) return null;
        await assertClinicalEvaluationRead(req,source,transaction);
        if(source.carePathId) await assertClinicalEvaluationContext(req,{carePathId:source.carePathId,patientId:source.patientId},transaction);
        return cloneEvaluation(schema, sourceId, { userId: req.user!.id }, transaction);
    });
    if (!created) {
        return sendErrorResponse(res, 404, 'Valutazione non trovata');
    }

    return sendSuccessResponse(res, 201, created, 'Valutazione duplicata correttamente');
});

/** Deleting an evaluation cascades to every symptom/articularity/strength/questionnaire/scale/test attached to it. */
export const deleteEvaluation = asyncHandler(async (req: Request, res: Response) => {
    const schema=req.tenantSchema!;
    const removed=await sequelize.transaction(async transaction=>{
        const evaluation=await Evaluation.schema(schema).findOne({where:{id:req.params.evaluationId,...scopeWhere(req,EVALUATION_SCOPE_FIELDS)},transaction,lock:transaction.LOCK.UPDATE});
        if(!evaluation) return false;
        await assertClinicalWriteContext(req,{patientId:evaluation.patientId,evaluationId:evaluation.id},transaction);
        if(await TestInstance.schema(schema).count({where:{evaluationId:evaluation.id,humanBodyPointId:{[Op.ne]:null}},transaction}))throw clinicalInputError('La valutazione contiene test collegati: conserva lo storico',409);
        if(await HumanBodyArea.schema(schema).count({where:{evaluationId:evaluation.id},transaction})||await UserScaleInstance.schema(schema).count({where:{evaluationId:evaluation.id,humanBodyPointId:{[Op.ne]:null}},transaction}))throw clinicalInputError('La valutazione contiene aree o scale collegate: conserva lo storico',409);
        if(evaluation.carePathId){
            const {ClinicalRecord}=await import('../../clinical/models/clinical.model.js');
            if(await ClinicalRecord.schema(schema).count({where:{evaluationId:evaluation.id},transaction}))throw clinicalInputError('La valutazione contiene documenti clinici: conserva lo storico e crea una rivalutazione',409);
        }
        await evaluation.destroy({transaction});
        return true;
    });
    if(!removed) return sendErrorResponse(res,404,'Valutazione non trovata');
    return sendSuccessResponse(res,200,null,'Valutazione eliminata');
});


/** A new daily assessment inherits setup only. Results and narrative conclusions are never copied. */
export const reassessEvaluation = asyncHandler(async (req: Request,res: Response)=>{
    const schema=req.tenantSchema!;
    const readScope=req.user?.isSuperAdmin?'tenant':resolveGrantedScope(getGrantedPermissions(req),'evaluation','read');
    if(!readScope)return sendErrorResponse(res,404,'Valutazione non trovata');
    const sourceRequest={...req,access:{...req.access!,scope:readScope}} as Request;
    const created=await sequelize.transaction(async transaction=>{
        const source=await Evaluation.schema(schema).findOne({where:{id:req.params.evaluationId,...scopeWhere(sourceRequest,EVALUATION_SCOPE_FIELDS)},transaction,lock:transaction.LOCK.SHARE});
        if(!source) return null;
        const patient=await Patient.schema(schema).findOne({where:{id:source.patientId,structureId:req.access?.structureId??null,archivedAt:null},transaction});
        if(!patient) return null;
        await assertClinicalEvaluationRead(req,source,transaction);
        if(source.carePathId) await assertClinicalEvaluationContext(req,{carePathId:source.carePathId,patientId:source.patientId,},transaction);
        return Evaluation.schema(schema).create({
            patientId:source.patientId,userId:req.user!.id,structureId:source.structureId,
            date:new Date(),title:req.body?.title??source.title,status:'DRAFT',notes:null,
            parentEvaluationId:source.id,publishedToPatient:false,
            carePathId:source.carePathId??null,clinicalVisibility:source.clinicalVisibility??null,templateVersionId:source.templateVersionId??null,
            configurationSnapshot:source.configurationSnapshot??null
        },{transaction});
    });
    if(!created) return sendErrorResponse(res,404,'Valutazione non trovata');
    return sendSuccessResponse(res,201,{...created.get({plain:true}),capabilities:await clinicalEvaluationCapabilities(req,created)},'Nuova rivalutazione creata');
});

export default {
    createEvaluation,
    getEvaluations,
    getEvaluationById,
    updateEvaluation,
    cloneEvaluationHandler,
    reassessEvaluation,
    deleteEvaluation
};


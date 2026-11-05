import type { Request } from 'express';
import type { Model, Transaction } from 'sequelize';
import Patient from '../../patients/models/patient.model.js';
import Evaluation from '../models/evaluation.model.js';
import HumanBodyPoint from '../../human-body/models/humanBodyPoint.model.js';
import { assertEvaluationEditable } from './evaluationGuard.js';

export function clinicalInputError(message: string, statusCode = 400): Error & {statusCode:number} {
    return Object.assign(new Error(message), {statusCode});
}

/** Validate every ancestor, including a persisted point when the client omits its evaluation. */
export async function assertClinicalWriteContext(
    req: Request,
    body: Record<string, unknown>,
    transaction: Transaction
): Promise<void> {
    const schema = req.tenantSchema!;
    let patientId = body.patientId as string | undefined;
    let evaluationId = body.evaluationId as string | undefined;
    if (body.humanBodyPointId) {
        const point = await HumanBodyPoint.schema(schema).findOne({
            where: {id:body.humanBodyPointId as string, ...(req.access?.scope==='own'?{userId:req.access.userId}:{})},
            transaction, lock:transaction.LOCK.SHARE
        });
        if (!point) throw clinicalInputError('Punto clinico non trovato',404);
        const pointPatient = point.get('patientId') as string;
        const pointEvaluation = point.get('evaluationId') as string | null;
        if (patientId && patientId!==pointPatient) throw clinicalInputError('Il punto non appartiene al paziente');
        if (body.evaluationId != null && body.evaluationId!==pointEvaluation) throw clinicalInputError('Il punto non appartiene alla valutazione');
        patientId=pointPatient;
        evaluationId=pointEvaluation ?? undefined;
        body.patientId=patientId;
        body.evaluationId=evaluationId ?? null;
    }
    await assertEvaluationEditable(schema,evaluationId,req.access?.scope==='own'?req.access.userId:undefined,transaction);
    if (evaluationId) {
        const evaluation=await Evaluation.schema(schema).findByPk(evaluationId,{transaction});
        if (!evaluation || (patientId && evaluation.get('patientId')!==patientId)) throw clinicalInputError('Valutazione e paziente non corrispondono');
        if (req.access?.structureId && evaluation.get('structureId')!==req.access.structureId) throw clinicalInputError('Valutazione non trovata',404);
        if(evaluation.get('carePathId')){
            const {loadClinicalPath,assertClinicalWrite}=await import('../../clinical/services/clinical.service.js');
            const access=await loadClinicalPath(req,evaluation.get('carePathId') as string,transaction);
            if(access.level!=='CLINICAL'&&evaluation.get('clinicalVisibility')!=='OPERATIONAL')throw clinicalInputError('Valutazione clinica non disponibile',404);
            await assertClinicalWrite(req,access,transaction,access.path.kind==='TRAINING'?'training':undefined);
            if(evaluation.get('userId')!==access.userId)throw clinicalInputError('Puoi modificare soltanto le tue valutazioni',403);
        }
        patientId=evaluation.get('patientId') as string;
        body.patientId=patientId;
    }
    if (!patientId) throw clinicalInputError('patientId obbligatorio');
    const patient=await Patient.schema(schema).findOne({
        where:{id:patientId,structureId:req.access?.structureId ?? null,archivedAt:null},
        transaction,lock:transaction.LOCK.SHARE
    });
    if (!patient) throw clinicalInputError('Paziente non trovato',404);
}

/** Never permit a partial update to reparent an existing clinical result. */
export function clinicalChanges(input: Record<string, unknown>, fields: readonly string[], record?: Model): Record<string,unknown> {
    const protectedFields=['id','patientId','evaluationId','humanBodyPointId','userId','createdAt','updatedAt'];
    const unchanged=(field:string)=>{
        if(!record)return false;
        const stored=record.get(field);
        if(stored instanceof Date)return new Date(input[field] as string).getTime()===stored.getTime();
        return String(input[field]??'')===String(stored??'');
    };
    if (protectedFields.some(field=>Object.prototype.hasOwnProperty.call(input,field) && !unchanged(field))) {
        throw clinicalInputError('I collegamenti e l\'autore di un dato clinico non sono modificabili');
    }
    const changes=Object.fromEntries(fields.filter(field=>Object.prototype.hasOwnProperty.call(input,field)).map(field=>[field,input[field]]));
    if (!Object.keys(changes).length) throw clinicalInputError('Nessun campo aggiornabile ricevuto');
    return changes;
}

export function clinicalRecordContext(record: Model): Record<string,unknown> {
    return {patientId:record.get('patientId'),evaluationId:record.get('evaluationId'),humanBodyPointId:record.get('humanBodyPointId')};
}

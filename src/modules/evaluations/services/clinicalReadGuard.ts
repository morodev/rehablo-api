import type {Request} from 'express';
import type {Transaction} from 'sequelize';
import Evaluation from '../models/evaluation.model.js';
import {evaluationCapabilities} from './evaluationGuard.js';
import {clinicalInputError} from './clinicalWriteGuard.js';

const value=(row:any,key:string)=>typeof row?.get==='function'?row.get(key):row?.[key];
/** Unscoped historical evaluations keep their original visibility; paths require live membership. */
export async function assertClinicalEvaluationRead(req:Request,evaluation:any,transaction?:Transaction) {
    const pathId=value(evaluation,'carePathId');
    if(!pathId)return;
    const {loadClinicalPath}=await import('../../clinical/services/clinical.service.js');
    const access=await loadClinicalPath(req,pathId,transaction);
    if(access.level!=='CLINICAL'&&value(evaluation,'clinicalVisibility')!=='OPERATIONAL')throw clinicalInputError('Valutazione clinica non disponibile',404);
    if(value(evaluation,'userId')!==access.userId&&(access.level!=='CLINICAL'||value(evaluation,'status')!=='COMPLETED'))
        throw clinicalInputError('Valutazione non disponibile',404);
}
export async function visibleClinicalEvaluations<T>(req:Request,rows:T[]):Promise<T[]>{
    const visible:T[]=[];
    for(const row of rows){
        try{await assertClinicalEvaluationRead(req,row);visible.push(row);}
        catch(error){if(![403,404].includes(Number((error as any).statusCode)))throw error;}
    }
    return visible;
}
/** Applied after the legacy scope, so this can only narrow existing permissions. */
export async function visibleClinicalRows<T>(req:Request,rows:T[]):Promise<T[]>{
    const decisions=new Map<string,boolean>();
    for(const id of new Set(rows.map(row=>value(row,'evaluationId')).filter(Boolean))){
        const evaluation=await Evaluation.schema(req.tenantSchema!).findByPk(id);
        if(!evaluation){decisions.set(id,false);continue;}
        try{await assertClinicalEvaluationRead(req,evaluation);decisions.set(id,true);}
        catch(error){if(![403,404].includes(Number((error as any).statusCode)))throw error;decisions.set(id,false);}
    }
    return rows.filter(row=>!value(row,'evaluationId')||decisions.get(value(row,'evaluationId'))===true);
}
export async function assertClinicalRowRead(req:Request,row:any){
    if(row&&!(await visibleClinicalRows(req,[row])).length)throw clinicalInputError('Dato clinico non disponibile',404);
}

export async function clinicalEvaluationCapabilities(req:Request,evaluation:Evaluation){
    const base=evaluationCapabilities(evaluation,req);
    if(!evaluation.carePathId)return base;
    const {loadClinicalPath,getClinicalCapabilities}=await import('../../clinical/services/clinical.service.js');
    const access=await loadClinicalPath(req,evaluation.carePathId);
    const flags=await getClinicalCapabilities(req);
    const enabled=flags.enabled&&(access.path.kind!=='TRAINING'||flags.trainingEnabled);
    const writable=enabled&&access.path.status==='ACTIVE'&&access.canContribute;
    return {canEdit:base.canEdit&&writable&&evaluation.userId===access.userId,canReassess:base.canReassess&&writable,
        lockReason:!enabled?'FEATURE_DISABLED':access.path.status!=='ACTIVE'?'PATH_NOT_ACTIVE':evaluation.userId!==access.userId?'NOT_OWNER':base.lockReason};
}

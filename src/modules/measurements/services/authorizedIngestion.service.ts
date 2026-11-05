import {getCurrentTenantId} from '../../../middleware/auth.js';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { sequelize } from '../../../config/database.js';
import Observation from '../models/observation.model.js';
import RawFile from '../models/rawFile.model.js';
import HumanBodyPoint from '../../human-body/models/humanBodyPoint.model.js';
import { resolveHumanBodyPointId } from '../../human-body/controllers/humanBodyPoint.helper.js';
import { assertClinicalWriteContext, clinicalInputError } from '../../evaluations/services/clinicalWriteGuard.js';
import { ingestObservations, type ObservationInput } from './observation.service.js';

interface IngestionOptions {
    operationId?: string;
    pointToCreate?: Record<string,unknown>;
    fingerprintInput?: unknown;
}
export async function authorizedIngestion(req: Request, original: ObservationInput[], options: IngestionOptions = {}) {
    const schema=req.tenantSchema!;
    const operatorId=req.user!.id;
    const tenantId=getCurrentTenantId(req);
    if(!original.length) return {created:[],skipped:[],humanBodyPoint:null,replayed:false};
    const operationId=options.operationId;
    if(operationId && (typeof operationId!=='string'||operationId.length>200)) throw clinicalInputError('operationId non valido');
    const fingerprint=createHash('sha256').update(JSON.stringify(options.fingerprintInput??{inputs:original,point:options.pointToCreate??null})).digest('hex');
    return sequelize.transaction(async transaction=>{
        const inputs=original.map(input=>{
            const {ingestionOperationId,ingestionFingerprint,...metadata}=input.metadata??{};
            return {...input,metadata};
        });
        for(const input of inputs) await assertClinicalWriteContext(req,input as unknown as Record<string,unknown>,transaction);
        if(operationId){
            await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))',{replacements:{key:schema+':'+operatorId+':'+operationId},transaction});
            const existing=await Observation.schema(schema).findAll({
                where:{operatorId,metadata:{ingestionOperationId:operationId}},transaction
            });
            if(existing.length){
                if(existing.some(row=>row.get('metadata')?.ingestionFingerprint!==fingerprint)) throw clinicalInputError('operationId gia utilizzato per dati differenti',409);
                const pointId=existing[0].get('humanBodyPointId');
                const point=pointId?await HumanBodyPoint.schema(schema).findByPk(pointId,{transaction}):null;
                return {created:existing,skipped:[],humanBodyPoint:point,replayed:true};
            }
        }
        let humanBodyPoint: HumanBodyPoint|null=null;
        if(options.pointToCreate){
            if(new Set(inputs.map(input=>input.patientId)).size!==1 || new Set(inputs.map(input=>input.evaluationId??null)).size!==1) throw clinicalInputError('Un punto deve appartenere a un solo paziente e valutazione');
            const body:Record<string,unknown>={patientId:inputs[0].patientId,evaluationId:inputs[0].evaluationId,pointToCreate:options.pointToCreate};
            const pointId=await resolveHumanBodyPointId(schema,body,operatorId,transaction);
            humanBodyPoint=pointId?await HumanBodyPoint.schema(schema).findByPk(pointId,{transaction}):null;
            for(const input of inputs){ input.humanBodyPointId=pointId; input.evaluationId=body.evaluationId as string|null; }
        }else if(inputs[0].humanBodyPointId) humanBodyPoint=await HumanBodyPoint.schema(schema).findByPk(inputs[0].humanBodyPointId,{transaction});
        for(const input of inputs){
            await assertClinicalWriteContext(req,input as unknown as Record<string,unknown>,transaction);
            if(input.rawFileId){
                const file=await RawFile.schema(schema).findOne({where:{id:input.rawFileId,uploadedBy:operatorId},transaction});
                if(!file) throw clinicalInputError('File originale non disponibile',404);
            }
            input.metadata={...input.metadata,...(operationId?{ingestionOperationId:operationId,ingestionFingerprint:fingerprint}:{})};
        }
        const result=await ingestObservations(schema,inputs,{tenantId,operatorId,transaction});
        if(options.pointToCreate&&!result.created.length) throw clinicalInputError('Nessuna misura valida: il punto non e stato creato');
        return {...result,humanBodyPoint,replayed:false};
    });
}

import TestInstance from '../../human-body/models/testInstance.model.js';
import HumanBodyPoint from '../../human-body/models/humanBodyPoint.model.js';
import HumanBodySymptom from '../../human-body/models/humanBodySymptom.model.js';
import HumanBodyArticularity from '../../human-body/models/humanBodyArticularity.model.js';
import HumanBodyStrength from '../../human-body/models/humanBodyStrength.model.js';
import HumanBodyQuestionnaireInstance from '../../human-body/models/humanBodyQuestionnaireInstance.model.js';
import UserScaleInstance from '../../human-body/models/userScaleInstance.model.js';
import Observation from '../../measurements/models/observation.model.js';
import type { Request } from 'express';
import { sequelize } from '../../../config/database.js';
import { patientResourceScopeWhere } from '../../../middleware/rbac.js';
import { assertEvaluationEditable } from './evaluationGuard.js';
import { assertClinicalWriteContext, clinicalInputError, clinicalChanges, clinicalRecordContext } from './clinicalWriteGuard.js';

/** Lock the persisted parent before touching its child; payload identifiers are never trusted. */
export async function updateClinicalRecord(req: Request, model: any, id: string, input: Record<string,unknown>, fields: readonly string[]) {
    return sequelize.transaction(async transaction=>{
        const scoped=model.schema(req.tenantSchema!);
        const record=await scoped.findOne({where:{id,...patientResourceScopeWhere(req,req.tenantSchema!)},transaction,lock:transaction.LOCK.UPDATE});
        if(!record) return null;
        await assertEvaluationEditable(req.tenantSchema!,record.get('evaluationId'),req.access?.scope==='own'?req.access.userId:undefined,transaction);
        await assertClinicalWriteContext(req,clinicalRecordContext(record),transaction);
        const changes=clinicalChanges(input,fields,record);
        await scoped.update(changes,{where:{id},transaction});
        return scoped.findByPk(id,{transaction});
    });
}
export async function deleteClinicalRecord(req: Request, model: any, id: string) {
    return sequelize.transaction(async transaction=>{
        const scoped=model.schema(req.tenantSchema!);
        const record=await scoped.findOne({where:{id,...patientResourceScopeWhere(req,req.tenantSchema!)},transaction,lock:transaction.LOCK.UPDATE});
        if(!record) return false;
        await assertEvaluationEditable(req.tenantSchema!,record.get('evaluationId'),req.access?.scope==='own'?req.access.userId:undefined,transaction);
        await assertClinicalWriteContext(req,clinicalRecordContext(record),transaction);
        if(model===HumanBodyPoint){
            if(await TestInstance.schema(req.tenantSchema!).count({where:{humanBodyPointId:id},transaction}))throw clinicalInputError('Il punto contiene test compilati e deve essere conservato nello storico',409);
            if(await UserScaleInstance.schema(req.tenantSchema!).count({where:{humanBodyPointId:id},transaction}))throw clinicalInputError('Il punto contiene scale compilate e deve essere conservato nello storico',409);
            for(const childModel of [HumanBodySymptom,HumanBodyArticularity,HumanBodyStrength,HumanBodyQuestionnaireInstance,Observation]){
                const children=await (childModel as any).schema(req.tenantSchema!).findAll({where:{humanBodyPointId:id},transaction,lock:transaction.LOCK.SHARE});
                for(const child of children)await assertClinicalWriteContext(req,clinicalRecordContext(child),transaction);
            }
        }
        await scoped.destroy({where:{id},transaction});
        return true;
    });
}

import {visibleClinicalRows} from '../../evaluations/services/clinicalReadGuard.js';
import {sequelize} from '../../../config/database.js';
import {assertClinicalWriteContext,clinicalInputError,clinicalRecordContext} from '../../evaluations/services/clinicalWriteGuard.js';
import {Request,Response} from 'express';
import {asyncHandler} from '../../../utils/asyncHandler.js';
import {patientResourceScopeWhere} from '../../../middleware/rbac.js';
import {withScope} from '../../../utils/scopedWhere.js';
import {sendSuccessResponse} from '../../../utils/response.js';
import {Test} from '../models/catalog/index.js';
import TestInstance from '../models/testInstance.model.js';
import HumanBodyPoint from '../models/humanBodyPoint.model.js';
import {resolveHumanBodyPointId} from './humanBodyPoint.helper.js';
import {captureTestSnapshot,testInstanceDto} from '../services/testSnapshot.js';
import {withClinicalOperation} from '../../clinical/services/clinical.service.js';

export const saveTest=asyncHandler(async(req:Request,res:Response)=>{
    const proposed=req.body.pointToCreate;
    if(proposed!=null&&(typeof proposed!=='object'||Array.isArray(proposed)))throw clinicalInputError('Punto non valido');
    if(typeof req.body.testId!=='string'||!req.body.testId)throw clinicalInputError('Test obbligatorio');
    if(req.body.isPositive!=null&&typeof req.body.isPositive!=='boolean')throw clinicalInputError('Esito del test non valido');
    if(req.body.notes!=null&&typeof req.body.notes!=='string')throw clinicalInputError('Note non valide');
    const body={...req.body,patientId:req.body.patientId??proposed?.patientId,evaluationId:req.body.evaluationId??proposed?.evaluationId??null};
    const payload=await sequelize.transaction(async transaction=>{
        await assertClinicalWriteContext(req,body,transaction);
        const input={patientId:body.patientId,evaluationId:body.evaluationId,testId:body.testId,
            humanBodyPointId:body.humanBodyPointId??null,pointToCreate:proposed??null,isPositive:body.isPositive??null,notes:body.notes??null};
        const save=async()=>{
            const catalog=await Test.findByPk(body.testId,{transaction});
            if(!catalog)throw clinicalInputError('Test non trovato',404);
            const humanBodyPointId=await resolveHumanBodyPointId(req.tenantSchema!,body,req.access!.userId,transaction);
            if((body.humanBodyPointId||proposed)&&!humanBodyPointId)throw clinicalInputError('Punto non disponibile',404);
            await assertClinicalWriteContext(req,{...body,humanBodyPointId},transaction);
            const instance=await TestInstance.schema(req.tenantSchema!).create({
                userId:req.access!.userId,patientId:body.patientId,evaluationId:body.evaluationId??null,humanBodyPointId,
                testId:body.testId,notes:body.notes??null,isPositive:body.isPositive??null,testSnapshot:captureTestSnapshot(catalog)
            },{transaction});
            return {id:instance.get('id') as string};
        };
        const saved=req.body.operationId==null?await save():await withClinicalOperation(req,req.body.operationId,'legacy-test-instance',input,transaction,save);
        const instance=await TestInstance.schema(req.tenantSchema!).findOne({where:{id:saved.id,...patientResourceScopeWhere(req,req.tenantSchema!)},transaction});
        if(!instance)throw clinicalInputError('Test compilato non disponibile',404);
        await assertClinicalWriteContext(req,clinicalRecordContext(instance),transaction);
        const point=instance.humanBodyPointId?await HumanBodyPoint.schema(req.tenantSchema!).findByPk(instance.humanBodyPointId,{transaction}):null;
        return {...testInstanceDto(instance),humanBodyPoint:point?.get({plain:true})??null};
    });
    return sendSuccessResponse(res,201,payload,'Test instance saved');
});

export const getUserTestInstances=asyncHandler(async(req:Request,res:Response)=>{
    const schema=req.tenantSchema!;
    const {patientId,evaluationId,humanBodyPointId}=req.query as {patientId?:string;evaluationId?:string;humanBodyPointId?:string};
    const where:Record<string,unknown>={};
    if(patientId)where.patientId=patientId;
    if(evaluationId)where.evaluationId=evaluationId;
    if(humanBodyPointId)where.humanBodyPointId=humanBodyPointId;
    const instances=await TestInstance.schema(schema).findAll({
        where:withScope(patientResourceScopeWhere(req,schema),where),
        include:[{model:Test,required:false}]
    });
    return sendSuccessResponse(res,200,(await visibleClinicalRows(req,instances)).map(testInstanceDto),'Test instances fetched');
});
export default {saveTest,getUserTestInstances};

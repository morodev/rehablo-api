import {visibleClinicalRows,assertClinicalRowRead} from '../../evaluations/services/clinicalReadGuard.js';
import { sequelize } from '../../../config/database.js';
import { assertClinicalWriteContext, clinicalInputError } from '../../evaluations/services/clinicalWriteGuard.js';
import { resolveHumanBodyPointId } from './humanBodyPoint.helper.js';
import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendSuccessResponse } from '../../../utils/response.js';
import HumanBodyArea from '../models/humanBodyArea.model.js';
import HumanBodySymptom from '../models/humanBodySymptom.model.js';

export const saveHumanBodyArea = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;

    const snapshot=areaSymptomSnapshot(req.body.symptom);
    const area=await sequelize.transaction(async transaction=>{
        await assertClinicalWriteContext(req,req.body,transaction);
        const area=await HumanBodyArea.schema(schema).create({...req.body,symptom:snapshot,userId:req.access!.userId},{transaction});
        if(req.body.symptom?.humanBodyPointId||req.body.symptom?.pointToCreate){
            const symptom={...req.body.symptom,patientId:req.body.patientId,evaluationId:req.body.evaluationId??null};
            const humanBodyPointId=await resolveHumanBodyPointId(schema,symptom,req.access!.userId,transaction);
            if(!humanBodyPointId) throw clinicalInputError('Il sintomo richiede un punto o pointToCreate');
            await assertClinicalWriteContext(req,{...symptom,humanBodyPointId},transaction);
            await HumanBodySymptom.schema(schema).create({...symptom,humanBodyPointId,humanBodyAreaId:area.get('id'),userId:req.access!.userId} as any,{transaction});
        }
        return area;
    });
    return sendSuccessResponse(res, 201, area, 'Human body area created');
});

export const getAllHumanBodyAreas = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const areas = await HumanBodyArea.schema(schema).findAll({
        where: { patientId: req.query.patientId as string, userId: req.user!.id, ...(req.query.evaluationId?{evaluationId:req.query.evaluationId as string}:{}) }
    });
    return sendSuccessResponse(res, 200, await visibleClinicalRows(req,areas), 'Human body areas loaded');
});

export default {
    saveHumanBodyArea,
    getAllHumanBodyAreas
};



/** Areas retain their entered symptom without inventing a point or a measured observation. */
export function areaSymptomSnapshot(input:unknown):Record<string,unknown>|null {
    if(input==null)return null;
    if(typeof input!=='object'||Array.isArray(input))throw clinicalInputError('Sintomo area non valido');
    const source=input as Record<string,unknown>;
    const snapshot:Record<string,unknown>={};
    for(const field of ['symptom','bodyPart','bodySubPart']){
        if(source[field]!=null&&typeof source[field]!=='string')throw clinicalInputError('Descrizione sintomo non valida');
        if(source[field]!==undefined)snapshot[field]=source[field];
    }
    for(const field of ['value','morningValue','afternoonValue','eveningValue','nightValue']){
        const value=source[field];
        if(value!=null&&(typeof value!=='number'||!Number.isFinite(value)))throw clinicalInputError('Intensita area non valida');
        snapshot[field]=value??null;
    }
    if(source.date!=null){
        const date=new Date(source.date as string);
        if(Number.isNaN(date.getTime()))throw clinicalInputError('Data del sintomo non valida');
        snapshot.date=date.toISOString();
    }
    return snapshot;
}

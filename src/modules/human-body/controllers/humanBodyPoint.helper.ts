import HumanBodyEvent from '../models/humanBodyEvent.model.js';
import HumanBodyPoint from '../models/humanBodyPoint.model.js';
import type { Transaction } from 'sequelize';
import { assertEvaluationEditable } from '../../evaluations/services/evaluationGuard.js';
import { clinicalInputError } from '../../evaluations/services/clinicalWriteGuard.js';

const POINT_FIELDS=['patientId','evaluationId','cxCoordinate','cyCoordinate','rDimension','bodyPart','fillColor','idSvg'] as const;
export async function resolveHumanBodyPointId(
    schema: string, body: Record<string,unknown>, userId: string, transaction?: Transaction
): Promise<string|null> {
    const id=body.humanBodyPointId as string|undefined;
    if (id) {
        const point=await HumanBodyPoint.schema(schema).findOne({where:{id,userId},transaction});
        if (!point) return null;
        const patientId=point.get('patientId');
        const evaluationId=point.get('evaluationId') as string|null;
        if (body.patientId && patientId && body.patientId!==patientId) throw clinicalInputError('Il punto non appartiene al paziente');
        if (body.evaluationId != null && body.evaluationId!==evaluationId) throw clinicalInputError('Il punto non appartiene alla valutazione');
        await assertEvaluationEditable(schema,evaluationId,userId,transaction);
        if (patientId) body.patientId=patientId;
        body.evaluationId=evaluationId??null;
        return point.get('id') as string;
    }
    const proposed=body.pointToCreate as Record<string,unknown>|undefined;
    if (!proposed) return null;
    if (body.patientId && proposed.patientId && body.patientId!==proposed.patientId) throw clinicalInputError('Paziente del punto non coerente');
    if (body.evaluationId != null && proposed.evaluationId != null && body.evaluationId!==proposed.evaluationId) throw clinicalInputError('Valutazione del punto non coerente');
    const values={...proposed,patientId:body.patientId??proposed.patientId,evaluationId:body.evaluationId??proposed.evaluationId??null};
    await assertEvaluationEditable(schema,values.evaluationId as string|null,userId,transaction);
    const point=await HumanBodyPoint.schema(schema).create({
        ...Object.fromEntries(POINT_FIELDS.filter(field=>values[field as keyof typeof values]!==undefined).map(field=>[field,(values as Record<string,unknown>)[field]])),userId
    } as any,{transaction});
    if(Array.isArray(proposed.humanBodyEvents)&&proposed.humanBodyEvents.length){
        await HumanBodyEvent.schema(schema).bulkCreate(proposed.humanBodyEvents.map((event:any)=>({humanBodyPointId:point.get('id') as string,eventType:event.eventType})),{transaction});
    }
    if(values.patientId) body.patientId=values.patientId;
    body.evaluationId=values.evaluationId;
    return point.get('id') as string;
}

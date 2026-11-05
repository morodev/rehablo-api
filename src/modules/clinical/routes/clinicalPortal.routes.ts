import PatientPortalAccess from '../../auth/models/patientPortalAccess.model.js';
import {Router, type Request} from 'express';
import type {Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {requireAuth,getCurrentTenantId} from '../../../middleware/auth.js';
import {resolveTenantSchema} from '../../../middleware/tenantSchema.js';
import {asyncHandler} from '../../../utils/asyncHandler.js';
import {sendSuccessResponse} from '../../../utils/response.js';
import {requirePatientPortalAccess} from '../../patient-portal/middleware/patientPortalAuth.js';
import Tenant from '../../auth/models/tenant.model.js';
import {CarePath,ClinicalRecord,ClinicalPublication,ClinicalHomeFeedback} from '../models/clinical.model.js';
import {loadClinicalRecord,loadClinicalPath,assertClinicalWrite,audit,withClinicalOperation} from '../services/clinical.service.js';
import {fail,uuid,expectedVersion} from '../services/clinical.policy.js';
import {canPublishClinicalRecord,validateHomeFeedback,publicClinicalData} from '../services/clinicalMedia.policy.js';
import {sendClinicalDocument,sendClinicalReport} from './clinicalMedia.routes.js';

const router=Router();
const staff=[requireAuth,resolveTenantSchema];
const patient=[requireAuth,requirePatientPortalAccess,resolveTenantSchema];

router.patch('/staff/patients/:patientId/portal/clinical-records/:id',...staff,asyncHandler(async(req,res)=>{
 const result=await sequelize.transaction(async transaction=>{
  const {record,access}=await loadClinicalRecord(req,req.params.id,transaction);
  if(record.patientId!==uuid(req.params.patientId))fail('Documento non trovato','NOT_FOUND',404);
  if(record.authorUserId!==access.userId&&!access.canManageMembers)fail('Pubblicazione non autorizzata','CLINICAL_ACCESS',403);
  if(typeof req.body.published!=='boolean')fail('Indica lo stato della pubblicazione');
  expectedVersion(req.body.expectedVersion,record.version);
  const model=ClinicalPublication.schema(req.tenantSchema!);
  let publication=await model.findOne({where:{recordId:record.id},transaction,lock:transaction.LOCK.UPDATE});
  if(req.body.published){
   if(!canPublishClinicalRecord(record))fail('Conferma il documento prima di pubblicarlo','RECORD_NOT_CONFIRMED',409);
   await assertClinicalWrite(req,access,transaction,record.kind==='REPORT'?'medical':(access.path.kind==='TRAINING'||record.kind==='PROGRAM'&&record.data.discipline==='PT')?'training':undefined);
   const values={recordId:record.id,patientId:record.patientId,carePathId:record.carePathId,structureId:record.structureId,publishedBy:access.userId,publishedAt:new Date(),revokedAt:null,sourceVersion:record.version};
   if(publication)await publication.update(values,{transaction});else publication=await model.create(values,{transaction});
  }else if(publication)await publication.update({revokedAt:new Date()},{transaction});
  await audit(req,req.body.published?'PORTAL_PUBLISHED':'PORTAL_REVOKED',transaction,record.carePathId,record.id,record.version);
  return publication?.get({plain:true})??{recordId:record.id,revokedAt:new Date()};
 });
 sendSuccessResponse(res,200,result,'Condivisione aggiornata');
}));
router.get('/care-paths/:pathId/home-feedback',...staff,asyncHandler(async(req,res)=>{
 const access=await loadClinicalPath(req,req.params.pathId);
 const rows=await ClinicalHomeFeedback.schema(req.tenantSchema!).findAll({where:{carePathId:access.path.id},order:[['createdAt','DESC']],limit:200});
 const visible: unknown[]=[];
 for(const row of rows){try{await loadClinicalRecord(req,row.recordId);visible.push(row.get({plain:true}));}catch(error){if((error as any).status!==404&&(error as any).statusCode!==404)throw error;}}
 sendSuccessResponse(res,200,visible);
}));
async function publishedRecord(req:Request,id:string,transaction?:Transaction){
 const publicationWhere={recordId:uuid(id),patientId:req.patientPortalAccess!.patientId,revokedAt:null};
 let publication=await ClinicalPublication.schema(req.tenantSchema!).findOne({where:publicationWhere,transaction});
 if(!publication)fail('Contenuto non disponibile','NOT_FOUND',404);
 let record=await ClinicalRecord.schema(req.tenantSchema!).findByPk(publication!.recordId,{transaction});
 const path=record?await CarePath.schema(req.tenantSchema!).findByPk(record.carePathId,{transaction,...(transaction?{lock:transaction.LOCK.SHARE}:{})}):null;
 if(transaction){
  // Match staff mutation order: path -> record -> publication, then recheck every link.
  record=await ClinicalRecord.schema(req.tenantSchema!).findByPk(publication!.recordId,{transaction,lock:transaction.LOCK.SHARE});
  publication=await ClinicalPublication.schema(req.tenantSchema!).findOne({where:publicationWhere,transaction,lock:transaction.LOCK.SHARE});
  if(!publication)fail('Contenuto non disponibile','NOT_FOUND',404);
 }
 if(!record||!path||record.carePathId!==path.id||!canPublishClinicalRecord(record)||record.version!==publication!.sourceVersion
  ||record.patientId!==req.patientPortalAccess!.patientId||path.patientId!==record.patientId
  ||publication!.carePathId!==path.id||record.structureId!==publication!.structureId||path.structureId!==record.structureId)fail('Contenuto non disponibile','NOT_FOUND',404);
 return {record:record!,publication:publication!,path:path!};
}
async function feedbackEnabled(req:Request,path:CarePath,record:ClinicalRecord,transaction?:Transaction){
 const tenant=await Tenant.findByPk(getCurrentTenantId(req),{transaction,...(transaction?{lock:transaction.LOCK.SHARE}:{})});
 const flags=(tenant?.get('featureFlags') as any)?.clinical;
 return req.patientPortalAccess!.status==='ACTIVE'&&path.status==='ACTIVE'&&flags?.enabled===true&&(path.kind!=='TRAINING'&&record.data?.discipline!=='PT'||flags?.trainingEnabled===true);
}
router.get('/patient-portal/clinical-records',...patient,asyncHandler(async(req,res)=>{
 const publications=await ClinicalPublication.schema(req.tenantSchema!).findAll({where:{patientId:req.patientPortalAccess!.patientId,revokedAt:null},order:[['publishedAt','DESC']],limit:200});
 const result: unknown[]=[];
 for(const publication of publications){
  try{
   const {record,path}=await publishedRecord(req,publication.recordId);
   const feedback=record.kind==='PROGRAM'?await ClinicalHomeFeedback.schema(req.tenantSchema!).findAll({where:{publicationId:publication.id,patientId:req.patientPortalAccess!.patientId},order:[['createdAt','DESC']],limit:20}):[];
   result.push({id:record.id,title:record.title,kind:record.kind,version:record.version,publishedAt:publication.publishedAt,
    data:publicClinicalData(record.kind,record.data),canSendFeedback:record.kind==='PROGRAM'&&await feedbackEnabled(req,path,record),
    feedback:feedback.map(row=>({id:row.get('id'),createdAt:row.get('createdAt'),...row.data}))});
  }catch(error){if((error as any).status!==404&&(error as any).statusCode!==404)throw error;}
 }
 sendSuccessResponse(res,200,result);
}));
router.get('/patient-portal/clinical-records/:id/download',...patient,asyncHandler(async(req,res)=>{
 const {record}=await publishedRecord(req,req.params.id);await sendClinicalDocument(req,res,record);
}));
router.get('/patient-portal/clinical-records/:id/pdf',...patient,asyncHandler(async(req,res)=>{
 const {record}=await publishedRecord(req,req.params.id);await sendClinicalReport(req,res,record);
}));
router.post('/patient-portal/clinical-records/:id/feedback',...patient,asyncHandler(async(req,res)=>{
 const result=await sequelize.transaction(async transaction=>{
  const userId=(req.user?.sub as string|undefined)??req.user?.id;
  const accessId=req.user?.patientAccessId as string|undefined;
  const patientId=req.user?.pid as string|undefined;
  if(!userId||!accessId||!patientId)fail('Contesto paziente incompleto','CLINICAL_ACCESS',403);
  const currentAccess=await PatientPortalAccess.findOne({where:{id:accessId,userId,tenantId:getCurrentTenantId(req),patientId,status:'ACTIVE'},transaction,lock:transaction.LOCK.SHARE});
  if(!currentAccess)fail('Invio non disponibile: accesso revocato o storico','CLINICAL_ACCESS',403);
  req.patientPortalAccess=currentAccess;
  const {record,publication,path}=await publishedRecord(req,req.params.id,transaction);
  if(record.kind!=='PROGRAM'||!await feedbackEnabled(req,path,record,transaction))fail('Invio non disponibile per questo programma','FEEDBACK_UNAVAILABLE',409);
  const data=validateHomeFeedback(req.body);const operationId=uuid(req.body.operationId,'Identificativo operazione')!;
  return withClinicalOperation(req,operationId,'patient-home-feedback',{recordId:record.id,sourceVersion:record.version,data},transaction,async()=>{
   const row=await ClinicalHomeFeedback.schema(req.tenantSchema!).create({publicationId:publication.id,recordId:record.id,patientId:record.patientId,
    carePathId:path.id,actorUserId:req.user!.id,operationId,data},{transaction});
   return {id:row.get('id'),createdAt:row.get('createdAt'),...data};
  });
 });
 sendSuccessResponse(res,201,result,'Attivita registrata');
}));
export default router;

import type {Request} from 'express';
import {Op, type Transaction} from 'sequelize';
import {createHash} from 'node:crypto';
import {sequelize} from '../../../config/database.js';
import {getCurrentTenantId} from '../../../middleware/auth.js';
import {getSelectedStructureId} from '../../../middleware/rbac.js';
import Tenant from '../../auth/models/tenant.model.js';
import TenantUser from '../../auth/models/tenantUser.model.js';
import StructureUser from '../../auth/models/structureUser.model.js';
import User from '../../auth/models/user.model.js';
import {resolveEffectiveRole,getRolePermissions} from '../../auth/rbac/roles.js';
import {resolveGrantedScope} from '../../auth/rbac/permissions.js';
import Patient from '../../patients/models/patient.model.js';
import Evaluation from '../../evaluations/models/evaluation.model.js';
import {assertEvaluationEditable,isEvaluationEditable} from '../../evaluations/services/evaluationGuard.js';
import Observation from '../../measurements/models/observation.model.js';
import RawFile from '../../measurements/models/rawFile.model.js';
import {CarePath,CarePathMember,ClinicalRecord,ClinicalOperation,ClinicalAudit,EvaluationTemplate,EvaluationPreference,ClinicalPublication} from '../models/clinical.model.js';
import type {ClinicalCapabilities,ClinicalVisibility,RecordKind} from '../clinical.types.js';
import {fail,uuid,text,choice,expectedVersion,validateRecordData,validateTemplate,mayReadRecord,assertPathTransition,comparableKey} from './clinical.policy.js';

export interface ClinicalAccess {path:CarePath;level:ClinicalVisibility;canManageMembers:boolean;canContribute:boolean;userId:string;role:string;}
const clinicalRoles=['OWNER','THERAPIST','PHYSIATRIST','ORTHOPEDIST','EXTERNAL_COLLABORATOR'];
const doctors=['PHYSIATRIST','ORTHOPEDIST'];
const medicalKinds:RecordKind[]=['VISIT','DIAGNOSIS','PRESCRIPTION','REPORT'];
const evaluatedKinds:RecordKind[]=['FINDING','SESSION','VISIT','DIAGNOSIS','PRESCRIPTION','REPORT'];
function recordModule(kind:RecordKind,data:any,access:ClinicalAccess):'medical'|'training'|undefined{return medicalKinds.includes(kind)?'medical':access.path.kind==='TRAINING'||access.role==='PERSONAL_TRAINER'||kind==='PROGRAM'&&data.discipline==='PT'||kind==='SESSION'&&data.programSnapshot?.discipline==='PT'?'training':undefined;}
const plain=(value:any)=>value?.get?value.get({plain:true}):value;
const clone=(value:any)=>JSON.parse(JSON.stringify(value));

export async function clinicalActor(req:Request,transaction?:Transaction){
 const userId=req.user?.id;const tenantId=getCurrentTenantId(req);const structureId=getSelectedStructureId(req);
 if(!userId||req.user?.actor==='patient'||!structureId)fail('Seleziona una sede autorizzata','CLINICAL_ACCESS',403);
 const options=transaction?{transaction,lock:transaction.LOCK.SHARE}:{};
 const [member,assignment,user]=await Promise.all([
 TenantUser.findOne({where:{tenantId,userId,deactivatedAt:null},...options}),
 StructureUser.findOne({where:{structureId,userId},...options}),
 User.findByPk(userId,{attributes:['id','isActive','deactivatedAt'],...options})]);
 if(!member||!assignment||!user?.get('isActive')||user.get('deactivatedAt'))fail('Accesso al centro revocato','CLINICAL_ACCESS',403);
 const role=resolveEffectiveRole(member.get('role') as string,assignment.get('role') as string|null);
 if(!role)fail('Ruolo non valido','CLINICAL_ACCESS',403);
 return {userId,tenantId,structureId,role,permissions:getRolePermissions(role)};
}
export async function getClinicalCapabilities(req:Request,transaction?:Transaction):Promise<ClinicalCapabilities>{
 const actor=await clinicalActor(req,transaction);const tenant=await Tenant.findByPk(actor.tenantId,{transaction});
 const flags=(tenant?.get('featureFlags') as any)?.clinical??{};
 const canRead=clinicalRoles.includes(actor.role)||actor.role==='PERSONAL_TRAINER';
 const canWrite=canRead&&(resolveGrantedScope(actor.permissions,'evaluation','create')!==null||resolveGrantedScope(actor.permissions,'protocol','create')!==null);
 return {enabled:flags.enabled===true,medicalEnabled:flags.medicalEnabled===true,trainingEnabled:flags.trainingEnabled===true,canManage:actor.role==='OWNER',canRead,canWrite,integrations:{ai:false,dictation:false,directDevices:false}};
}
export async function setClinicalCapabilities(req:Request,body:any){
 return sequelize.transaction(async transaction=>{
 const actor=await clinicalActor(req,transaction);if(actor.role!=='OWNER')fail('Solo il titolare può abilitare i moduli','CLINICAL_ACCESS',403);
 const tenant=await Tenant.findByPk(actor.tenantId,{transaction,lock:transaction.LOCK.UPDATE});if(!tenant)fail('Centro non trovato','NOT_FOUND',404);
 const current=(tenant.get('featureFlags') as any)??{};const clinical={...(current.clinical??{})};
 for(const key of Object.keys(body)){if(!['enabled','medicalEnabled','trainingEnabled'].includes(key)||typeof body[key]!=='boolean')fail('Configurazione non valida');clinical[key]=body[key];}
 await tenant.update({featureFlags:{...current,clinical}},{transaction});return getClinicalCapabilities(req,transaction);
 });
}
export async function loadClinicalPath(req:Request,pathId:string,transaction?:Transaction):Promise<ClinicalAccess>{
 uuid(pathId);const actor=await clinicalActor(req,transaction);
 if(!clinicalRoles.includes(actor.role)&&actor.role!=='PERSONAL_TRAINER')fail('Ruolo non autorizzato','CLINICAL_ACCESS',403);
 const path=await CarePath.schema(req.tenantSchema!).findOne({where:{id:pathId,structureId:actor.structureId},transaction,...(transaction?{lock:transaction.LOCK.UPDATE}:{})});
 if(!path)fail('Percorso non trovato','NOT_FOUND',404);
 const patient=await Patient.schema(req.tenantSchema!).findOne({where:{id:path.patientId,structureId:actor.structureId,archivedAt:null},transaction});
 if(!patient)fail('Paziente non disponibile','NOT_FOUND',404);
 const member=await CarePathMember.schema(req.tenantSchema!).findOne({where:{carePathId:pathId,userId:actor.userId,revokedAt:null},transaction,...(transaction?{lock:transaction.LOCK.SHARE}:{})});
 if(!member)fail('Percorso non disponibile','NOT_FOUND',404);
 const level:ClinicalVisibility=clinicalRoles.includes(actor.role)&&member.level==='CLINICAL'?'CLINICAL':'OPERATIONAL';
 const canContribute=resolveGrantedScope(actor.permissions,'evaluation','create')!==null||resolveGrantedScope(actor.permissions,'protocol','create')!==null;
 return {path,level,canContribute,canManageMembers:path.ownerUserId===actor.userId,userId:actor.userId,role:actor.role};
}
export async function assertClinicalWrite(req:Request,access:ClinicalAccess,transaction?:Transaction,module?:'medical'|'training'){
 const capabilities=await getClinicalCapabilities(req,transaction);
 if(!capabilities.enabled||module==='medical'&&!capabilities.medicalEnabled||(module==='training'||access.role==='PERSONAL_TRAINER')&&!capabilities.trainingEnabled)fail('Modulo non abilitato: lo storico rimane consultabile','FEATURE_DISABLED',409);
 if(!access.canContribute)fail('Operazione non autorizzata','CLINICAL_ACCESS',403);
 if(access.path.status!=='ACTIVE')fail('Il percorso non è attivo','PATH_NOT_ACTIVE',409);
}
export async function assertRecordEditable(req:Request,record:ClinicalRecord,access:ClinicalAccess,transaction:Transaction){
 await assertClinicalWrite(req,access,transaction,recordModule(record.kind,record.data,access));
 if(record.authorUserId!==access.userId)fail('Puoi modificare soltanto i tuoi contributi','CLINICAL_ACCESS',403);
 if(!['PROBLEM','GOAL'].includes(record.kind)&&record.status!=='DRAFT')fail('Il documento confermato è immutabile: crea una revisione','RECORD_LOCKED',409);
 if(['ARCHIVED','CANCELLED'].includes(record.status))fail('Elemento archiviato','RECORD_LOCKED',409);
 if(record.evaluationId){const evaluation=await Evaluation.schema(req.tenantSchema!).findByPk(record.evaluationId,{transaction});if(access.level==='OPERATIONAL'&&evaluation?.clinicalVisibility!=='OPERATIONAL')fail('Valutazione non disponibile','NOT_FOUND',404);await assertEvaluationEditable(req.tenantSchema!,record.evaluationId,access.userId,transaction);}
}
export async function loadClinicalRecord(req:Request,id:string,transaction?:Transaction){
 uuid(id);let record=await ClinicalRecord.schema(req.tenantSchema!).findByPk(id,{transaction});
 if(!record)fail('Elemento non trovato','NOT_FOUND',404);
 const access=await loadClinicalPath(req,record.carePathId,transaction);
 if(medicalKinds.includes(record.kind)&&access.level!=='CLINICAL')fail('Elemento non disponibile','NOT_FOUND',404);
 if(transaction){record=await ClinicalRecord.schema(req.tenantSchema!).findByPk(id,{transaction,lock:transaction.LOCK.UPDATE});if(!record||record.carePathId!==access.path.id)fail('Elemento non disponibile','NOT_FOUND',404);}
 let visible=mayReadRecord(record,access.userId,access.level);
 if(!visible&&!['CANCELLED','ARCHIVED'].includes(record.status)&&record.evaluationId&&(record.visibility==='OPERATIONAL'||access.level==='CLINICAL')){
 const evaluation=await Evaluation.schema(req.tenantSchema!).findByPk(record.evaluationId,{transaction});visible=evaluation?.status==='COMPLETED';
 }
 if(!visible)fail('Elemento non disponibile','NOT_FOUND',404);
 return {record,access};
}
export async function assertClinicalEvaluationContext(req:Request,body:{carePathId?:string|null;patientId:string;templateVersionId?:string|null},transaction?:Transaction){
 if(!body.carePathId){if(body.templateVersionId)fail('Il modello richiede un percorso');return {carePathId:null,templateVersionId:null,configurationSnapshot:null,clinicalVisibility:null};}
 const access=await loadClinicalPath(req,body.carePathId,transaction);
 await assertClinicalWrite(req,access,transaction,access.path.kind==='TRAINING'?'training':undefined);
 if(access.path.patientId!==body.patientId)fail('Paziente e percorso non corrispondono');
 let snapshot:Record<string,unknown>|null=null;
 if(body.templateVersionId){const template=await loadTemplate(req,body.templateVersionId,transaction);
 if(template.status!=='PUBLISHED')fail('Seleziona una versione pubblicata del modello');
 snapshot=clone(template.data);
 }else{const pref=await EvaluationPreference.schema(req.tenantSchema!).findOne({where:{userId:access.userId,structureId:access.path.structureId},transaction});
 if(pref)snapshot=clone(pref.data);}
 return {carePathId:access.path.id,clinicalVisibility:access.level,templateVersionId:body.templateVersionId??null,configurationSnapshot:snapshot};
}
export async function audit(req:Request,action:string,transaction:Transaction,carePathId?:string,recordId?:string,version?:number){
 await ClinicalAudit.schema(req.tenantSchema!).create({actorUserId:req.user!.id,action,carePathId:carePathId??null,recordId:recordId??null,version:version??null},{transaction});
}
export async function withClinicalOperation<T>(req:Request,operationId:unknown,label:string,input:unknown,transaction:Transaction,run:()=>Promise<T>):Promise<T>{
 const id=uuid(operationId,'Identificativo operazione')!;const userId=req.user!.id;
 await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:schema), hashtext(:key))',{replacements:{schema:req.tenantSchema!,key:userId+':'+id},transaction});
 const fingerprint=createHash('sha256').update(JSON.stringify({label,input})).digest('hex');
 const previous=await ClinicalOperation.schema(req.tenantSchema!).findOne({where:{operationId:id,userId},transaction});
 if(previous){if(previous.fingerprint!==fingerprint)fail('Identificativo operazione già utilizzato','OPERATION_CONFLICT',409);return clone(previous.result) as T;}
 const result=await run();await ClinicalOperation.schema(req.tenantSchema!).create({operationId:id,userId,fingerprint,result:clone(result)},{transaction});return result;
}
export async function listPaths(req:Request,patientId?:string){
 const actor=await clinicalActor(req);const caps=await getClinicalCapabilities(req);if(!caps.canRead)fail('Accesso clinico non consentito','CLINICAL_ACCESS',403);
 if(patientId)uuid(patientId);
 const members=await CarePathMember.schema(req.tenantSchema!).findAll({where:{userId:actor.userId,revokedAt:null},attributes:['carePathId']});
 const paths=await CarePath.schema(req.tenantSchema!).findAll({where:{id:{[Op.in]:members.map(m=>m.carePathId)},structureId:actor.structureId,...(patientId?{patientId}:{})},order:[['updatedAt','DESC']],limit:200});
 return Promise.all(paths.map(async path=>pathDto(await loadClinicalPath(req,path.id))));
}
export function pathDto(access:ClinicalAccess){return {...plain(access.path),capabilities:{canReadClinical:access.level==='CLINICAL',canContribute:access.canContribute,canManageMembers:access.canManageMembers,canEdit:access.canManageMembers&&access.path.status!=='COMPLETED'}};}
export async function createPath(req:Request,body:any){
 return sequelize.transaction(async transaction=>{
 const actor=await clinicalActor(req,transaction);const caps=await getClinicalCapabilities(req,transaction);
 if(!caps.enabled||!caps.canWrite)fail('Creazione percorso non disponibile','FEATURE_DISABLED',409);
 const patientId=uuid(body.patientId,'Paziente')!;const title=text(body.title,'Titolo',240,true)!;
 const kind=choice(body.kind,['REHAB','TRAINING'] as const,'Percorso','REHAB');
 if(kind==='TRAINING'&&!caps.trainingEnabled)fail('Modulo allenamento non abilitato','FEATURE_DISABLED',409);
 if(actor.role==='PERSONAL_TRAINER'&&kind!=='TRAINING')fail('Il personal trainer crea percorsi di allenamento');
 const patient=await Patient.schema(req.tenantSchema!).findOne({where:{id:patientId,structureId:actor.structureId,archivedAt:null},transaction});
 if(!patient)fail('Paziente non trovato','NOT_FOUND',404);
 return withClinicalOperation(req,body.operationId,'create-path',{patientId,title,kind},transaction,async()=>{
 const path=await CarePath.schema(req.tenantSchema!).create({patientId,structureId:actor.structureId,ownerUserId:actor.userId,title,kind,status:'ACTIVE',version:1},{transaction});
 await CarePathMember.schema(req.tenantSchema!).create({carePathId:path.id,userId:actor.userId,level:actor.role==='PERSONAL_TRAINER'?'OPERATIONAL':'CLINICAL',assignedByUserId:actor.userId},{transaction});
 await audit(req,'PATH_CREATED',transaction,path.id);return pathDto(await loadClinicalPath(req,path.id,transaction));});
 });
}
export async function updatePath(req:Request,pathId:string,body:any){return sequelize.transaction(async transaction=>{
 const access=await loadClinicalPath(req,pathId,transaction);const caps=await getClinicalCapabilities(req,transaction);
 if(!caps.enabled||!access.canManageMembers)fail('Modifica percorso non autorizzata','CLINICAL_ACCESS',403);
 expectedVersion(body.expectedVersion,access.path.version);
 const status=choice(body.status??access.path.status,['ACTIVE','SUSPENDED','COMPLETED'] as const,'Stato');
 assertPathTransition(access.path.status,status);
 const title=body.title===undefined?access.path.title:text(body.title,'Titolo',240,true);
 if(access.path.status==='COMPLETED')fail('Il percorso concluso è immodificabile','PATH_COMPLETED',409);
 await access.path.update({title,status,version:access.path.version+1},{transaction});await audit(req,'PATH_UPDATED',transaction,pathId,undefined,access.path.version);
 return pathDto(access);});}
export async function eligibleMembers(req:Request,pathId:string,transaction?:Transaction){
 const access=await loadClinicalPath(req,pathId,transaction);if(!access.canManageMembers)fail('Operazione non autorizzata','CLINICAL_ACCESS',403);
 const assignments=await StructureUser.findAll({where:{structureId:access.path.structureId},transaction});const ids=assignments.map(x=>x.userId);
 const memberships=await TenantUser.findAll({where:{tenantId:getCurrentTenantId(req),userId:{[Op.in]:ids},deactivatedAt:null},transaction});
 const users=await User.findAll({where:{id:{[Op.in]:ids},isActive:true,deactivatedAt:null},attributes:['id','name','surname'],transaction});
 return memberships.map(m=>{const role=resolveEffectiveRole(m.role,assignments.find(x=>x.userId===m.userId)?.role??null);const user=users.find(x=>x.get('id')===m.userId);return role&&user&&(clinicalRoles.includes(role)||role==='PERSONAL_TRAINER')?{userId:m.userId,name:user.get('name'),surname:user.get('surname'),role,level:role==='PERSONAL_TRAINER'?'OPERATIONAL':'CLINICAL'}:null;}).filter(Boolean);
}
export async function addMember(req:Request,pathId:string,body:any){return sequelize.transaction(async transaction=>{
 const access=await loadClinicalPath(req,pathId,transaction);await assertClinicalWrite(req,access,transaction);
 const candidates=await eligibleMembers(req,pathId,transaction);const userId=uuid(body.userId)!;const candidate=candidates.find(c=>c?.userId===userId);if(!candidate)fail('Professionista non disponibile');
 const level=choice(body.level,['CLINICAL','OPERATIONAL'] as const,'Accesso');
 if(candidate.level==='OPERATIONAL'&&level==='CLINICAL')fail('Il ruolo non consente accesso clinico');
 return withClinicalOperation(req,body.operationId,'add-member',{pathId,userId,level},transaction,async()=>{
 const [member]=await CarePathMember.schema(req.tenantSchema!).findOrCreate({where:{carePathId:pathId,userId},defaults:{level,assignedByUserId:access.userId,revokedAt:null},transaction});
 await member.update({level,assignedByUserId:access.userId,revokedAt:null},{transaction});await audit(req,'MEMBER_ADDED',transaction,pathId);return {...plain(member),...candidate,level};
 });});}
export async function revokeMember(req:Request,pathId:string,userId:string){return sequelize.transaction(async transaction=>{
 const access=await loadClinicalPath(req,pathId,transaction);
 if(!access.canManageMembers||userId===access.path.ownerUserId)fail('Non puoi rimuovere il responsabile','CLINICAL_ACCESS',403);
 await CarePathMember.schema(req.tenantSchema!).update({revokedAt:new Date()},{where:{carePathId:pathId,userId:uuid(userId)},transaction});
 await audit(req,'MEMBER_REVOKED',transaction,pathId);return {revoked:true};});}
export async function loadTemplate(req:Request,id:string,transaction?:Transaction){
 const actor=await clinicalActor(req,transaction);const template=await EvaluationTemplate.schema(req.tenantSchema!).findOne({where:{id:uuid(id),structureId:actor.structureId,[Op.or]:[{ownerUserId:actor.userId},{scope:'STRUCTURE',status:'PUBLISHED'}]},transaction,...(transaction?{lock:transaction.LOCK.UPDATE}:{})});
 if(!template)fail('Modello non disponibile','NOT_FOUND',404);return template;
}

export async function recordDto(req:Request,record:ClinicalRecord,access:ClinicalAccess,transaction?:Transaction){
 const caps=await getClinicalCapabilities(req,transaction);let daily=true;
 if(record.evaluationId){const e=await Evaluation.schema(req.tenantSchema!).findByPk(record.evaluationId,{transaction});daily=!!e&&isEvaluationEditable(e)&&e.userId===access.userId&&(access.level==='CLINICAL'||e.clinicalVisibility==='OPERATIONAL');}
 const module=recordModule(record.kind,record.data,access);const moduleEnabled=caps.enabled&&(module!=='medical'||caps.medicalEnabled)&&(module!=='training'||caps.trainingEnabled);
 const canMutate=moduleEnabled&&(!medicalKinds.includes(record.kind)||doctors.includes(access.role));
 const canEdit=canMutate&&access.canContribute&&access.path.status==='ACTIVE'&&record.authorUserId===access.userId&&daily&&(['PROBLEM','GOAL'].includes(record.kind)||record.status==='DRAFT')&&!['ARCHIVED','CANCELLED'].includes(record.status);
 const publication=await ClinicalPublication.schema(req.tenantSchema!).findOne({where:{recordId:record.id},transaction});
 return {...plain(record),publishedToPatient:!!publication&&!publication.revokedAt&&publication.sourceVersion===record.version,publicationRevokedAt:publication?.revokedAt??null,capabilities:{canEdit,canConfirm:canEdit&&record.status==='DRAFT',canRevise:canMutate&&access.canContribute&&access.path.status==='ACTIVE'&&['PROGRAM','REPORT','PRESCRIPTION'].includes(record.kind)&&record.status==='CONFIRMED',canPublish:moduleEnabled&&(record.authorUserId===access.userId||access.canManageMembers)&&record.status==='CONFIRMED'&&['PROGRAM','REPORT','DOCUMENT'].includes(record.kind)}};
}
async function visibleRecords(req:Request,access:ClinicalAccess,transaction?:Transaction){
 const records=await ClinicalRecord.schema(req.tenantSchema!).findAll({where:{carePathId:access.path.id},order:[['createdAt','ASC']],limit:2000,transaction});
 const completed=await Evaluation.schema(req.tenantSchema!).findAll({where:{carePathId:access.path.id,status:'COMPLETED'},attributes:['id'],transaction});
 const ids=new Set(completed.map(e=>e.id));
 return records.filter(r=>(access.level==='CLINICAL'||!medicalKinds.includes(r.kind))&&(mayReadRecord(r,access.userId,access.level)||(!['CANCELLED','ARCHIVED'].includes(r.status)&&r.evaluationId&&ids.has(r.evaluationId)&&(r.visibility==='OPERATIONAL'||access.level==='CLINICAL'))));
}
export async function pathDetail(req:Request,id:string){
 const access=await loadClinicalPath(req,id);const records=await visibleRecords(req,access);
 const members=await CarePathMember.schema(req.tenantSchema!).findAll({where:{carePathId:id,revokedAt:null}});
 const users=await User.findAll({where:{id:{[Op.in]:members.map(m=>m.userId)}},attributes:['id','name','surname']});
 const evaluations=await Evaluation.schema(req.tenantSchema!).findAll({where:{carePathId:id,...(access.level==='CLINICAL'?{[Op.or]:[{userId:access.userId},{status:'COMPLETED'}]}:{userId:access.userId,clinicalVisibility:'OPERATIONAL'})},order:[['createdAt','DESC']]});
 const caps=await getClinicalCapabilities(req);const canWrite=caps.enabled&&access.canContribute&&access.path.status==='ACTIVE'&&((access.path.kind!=='TRAINING'&&access.role!=='PERSONAL_TRAINER')||caps.trainingEnabled);
 const dto=await Promise.all(records.map(r=>recordDto(req,r,access)));
 const result:Record<string,unknown>={path:pathDto(access),members:members.map(m=>({...plain(m),name:users.find(u=>u.get('id')===m.userId)?.get('name'),surname:users.find(u=>u.get('id')===m.userId)?.get('surname')})),evaluations:evaluations.map(e=>({...plain(e),capabilities:{canEdit:canWrite&&e.userId===access.userId&&isEvaluationEditable(e),canReassess:canWrite&&e.userId===access.userId,lockReason:e.userId!==access.userId?'NOT_OWNER':e.status==='COMPLETED'?'COMPLETED':isEvaluationEditable(e)?null:'DAY_EXPIRED'}}))};
 const collections:Record<string,RecordKind>={problems:'PROBLEM',goals:'GOAL',findings:'FINDING',programs:'PROGRAM',sessions:'SESSION',visits:'VISIT',diagnoses:'DIAGNOSIS',prescriptions:'PRESCRIPTION',reports:'REPORT',documents:'DOCUMENT'};
 for(const [name,kind]of Object.entries(collections))result[name]=dto.filter(r=>r.kind===kind);return result;
}
async function validateLinks(req:Request,access:ClinicalAccess,kind:RecordKind,data:any,evaluationId:string|null,transaction:Transaction,recordId?:string){
 const schema=req.tenantSchema!;
 if(evaluationId){const evaluation=await Evaluation.schema(schema).findByPk(uuid(evaluationId),{transaction});
 if(access.level==='OPERATIONAL'&&evaluation?.clinicalVisibility!=='OPERATIONAL')fail('Valutazione non disponibile','NOT_FOUND',404);
 if(!evaluation||evaluation.patientId!==access.path.patientId||evaluation.structureId!==access.path.structureId||evaluation.carePathId!==access.path.id)fail('La valutazione non appartiene al percorso');
 await assertEvaluationEditable(schema,evaluationId,access.userId,transaction);}
 else if(evaluatedKinds.includes(kind))fail('La rilevazione richiede una valutazione giornaliera','EVALUATION_REQUIRED');
 for(const [key,expectedKind]of [['problemId','PROBLEM'],['visitId','VISIT']] as const){if(data[key]){
 const linked=await loadClinicalRecord(req,data[key],transaction);if(linked.record.carePathId!==access.path.id||linked.record.kind!==expectedKind)fail('Collegamento clinico non valido');
 }}
 if(data.baselineObservationId||data.observationId){
 const observation=await Observation.schema(schema).findByPk(data.baselineObservationId??data.observationId,{transaction});
 if(!observation||observation.patientId!==access.path.patientId)fail('Misura non disponibile');
 const linkedEval=observation.evaluationId?await Evaluation.schema(schema).findByPk(observation.evaluationId,{transaction}):null;
 if(!linkedEval||linkedEval.carePathId!==access.path.id||(linkedEval.userId!==access.userId&&(access.level!=='CLINICAL'||linkedEval.status!=='COMPLETED')))fail('Misura non autorizzata');
 if(kind==='FINDING'&&observation.evaluationId!==evaluationId)fail('La misura non appartiene alla valutazione corrente');
 }
 if(kind==='DOCUMENT'){
 const raw=await RawFile.schema(schema).findByPk(data.rawFileId,{transaction});
 if(!raw||raw.tenantId!==getCurrentTenantId(req)||raw.uploadedBy!==access.userId)fail('File non disponibile','NOT_FOUND',404);
 const documentType=raw.mimeType.startsWith('image/')?'PHOTO':raw.mimeType.startsWith('video/')?'VIDEO':'DOCUMENT';
 if(data.documentType!==documentType)fail('Tipo documento non coerente con il file');
 Object.assign(data,{fileName:raw.originalName,mimeType:raw.mimeType,sizeBytes:raw.sizeBytes,checksumSha256:raw.checksumSha256});
 const links=await ClinicalRecord.schema(schema).findAll({where:{kind:'DOCUMENT'},transaction});
 if(links.some(r=>r.data.rawFileId===data.rawFileId&&r.carePathId!==access.path.id))fail('File già associato ad altro percorso');
 }
 if(kind==='PROGRAM'){
 for(const id of data.objectiveIds??[]){const goal=await loadClinicalRecord(req,id,transaction);if(goal.record.kind!=='GOAL'||goal.record.carePathId!==access.path.id)fail('Obiettivo non valido');}
 if(access.role==='PERSONAL_TRAINER'&&data.discipline!=='PT')fail('Programma non disponibile al ruolo');
 }
 if(kind==='SESSION'){
 const program=await loadClinicalRecord(req,data.programId,transaction);
 if(program.record.kind!=='PROGRAM'||program.record.carePathId!==access.path.id||program.record.status!=='CONFIRMED')fail('Seleziona un programma confermato');
 const current=recordId?await ClinicalRecord.schema(schema).findByPk(recordId,{transaction}):null;
 if(current&&current.data.programId!==data.programId)fail('Il programma della seduta non può essere sostituito');
 const snapshot=current?.data.programSnapshot??clone({id:program.record.id,version:program.record.version,title:program.record.title,...program.record.data});
 const itemIds=new Set((snapshot.items??[]).map((item:any)=>item.id));
 if(data.results.some((r:any)=>!itemIds.has(r.itemId)))fail('Attività non appartenente al programma della seduta');data.programSnapshot=snapshot;
 }
}
async function storeFindingMeasure(req:Request,access:ClinicalAccess,data:any,evaluationId:string,transaction:Transaction,previous?:ClinicalRecord){
 const previousId=previous?.data.observationId;
 if(data.observationId){const linked=await Observation.schema(req.tenantSchema!).findByPk(data.observationId,{transaction});
 if(linked&&(!previousId||linked.metadata?.clinicalFinding!==true)){if(['NOT_COLLECTED','NOT_ASSESSABLE','DECLINED'].includes(data.collectionState)){data.observationId=null;return;}if(data.intensity!==null&&data.intensity!==undefined&&data.intensity!==linked.value)fail('Il risultato deve corrispondere alla misura collegata');return;}}
 if(previousId){
 const original=await Observation.schema(req.tenantSchema!).findOne({where:{id:previousId,evaluationId,operatorId:access.userId},transaction});
 if(!original)fail('Misura non modificabile');
 if(original.value===data.intensity&&original.metricCode==='clinical.'+data.code&&original.side===(['LEFT','RIGHT','BILATERAL'].includes(data.side)?data.side:'UNSPECIFIED')&&original.metadata?.protocol===(data.method??data.code)&&original.metadata?.source===data.source&&original.metadata?.clinicalSide===(data.side??null)&&original.unit===(data.scale==='0_100'?'score/100':'score/10')){data.observationId=original.id;return;}
 // Retain the original measurement: supersession is explicit and auditable, never deletion.
 if(original.metadata?.clinicalFinding===true)await original.update({quality:'INVALID',metadata:{...original.metadata,supersededAt:new Date().toISOString(),supersededByUserId:access.userId,supersededReason:'FINDING_DRAFT_CORRECTION'}},{transaction});
 }
 if(data.intensity===null||data.intensity===undefined){data.observationId=null;return;}
 const observation={tenantId:getCurrentTenantId(req),patientId:access.path.patientId,evaluationId,metricCode:'clinical.'+data.code,unit:data.scale==='0_100'?'score/100':'score/10',side:['LEFT','RIGHT','BILATERAL'].includes(data.side)?data.side:'UNSPECIFIED',value:data.intensity,aggregation:'SINGLE' as const,effectiveDateTime:new Date(),operatorId:access.userId,quality:'GOOD' as const,provenance:'MANUAL' as const,metadata:{clinicalFinding:true,carePathId:access.path.id,problemId:data.problemId??null,source:data.source,clinicalSide:data.side??null,scale:data.scale,protocol:data.method??data.code,protocolVersion:'1',supersedesObservationId:previousId??null}};
 const saved=await Observation.schema(req.tenantSchema!).create(observation,{transaction});data.observationId=saved.id;
}
export async function createRecord(req:Request,pathId:string,kind:RecordKind,body:any){return sequelize.transaction(async transaction=>{
 const access=await loadClinicalPath(req,pathId,transaction);
 await assertClinicalWrite(req,access,transaction,medicalKinds.includes(kind)?'medical':access.path.kind==='TRAINING'?'training':undefined);
 if(medicalKinds.includes(kind)&&!doctors.includes(access.role))fail('Operazione riservata al medico','CLINICAL_ACCESS',403);
 const title=text(body.title,'Titolo',240,true)!;const data=validateRecordData(kind,body.data??{});
 const evaluationId=uuid(body.evaluationId,'Valutazione',false)??null;
 const visibility=choice(body.visibility,['CLINICAL','OPERATIONAL'] as const,'Visibilità',access.path.kind==='TRAINING'||kind==='GOAL'?'OPERATIONAL':'CLINICAL');
 if(medicalKinds.includes(kind)&&visibility!=='CLINICAL')fail('I documenti medici richiedono visibilità clinica');
 if(access.level==='OPERATIONAL'&&visibility!=='OPERATIONAL')fail('Visibilità non consentita');
 await validateLinks(req,access,kind,data,evaluationId,transaction);
 await assertClinicalWrite(req,access,transaction,recordModule(kind,data,access));
 return withClinicalOperation(req,body.operationId,'create-'+kind,{pathId,title,data,evaluationId,visibility},transaction,async()=>{
 if(kind==='SESSION'){const open=await ClinicalRecord.schema(req.tenantSchema!).findAll({where:{carePathId:pathId,authorUserId:access.userId,kind:'SESSION',status:'DRAFT',evaluationId},transaction});const existing=open.find(r=>r.data.programId===data.programId);if(existing)return recordDto(req,existing,access,transaction);}
 if(kind==='FINDING')await storeFindingMeasure(req,access,data,evaluationId!,transaction);
 const record=await ClinicalRecord.schema(req.tenantSchema!).create({carePathId:pathId,patientId:access.path.patientId,structureId:access.path.structureId,authorUserId:access.userId,kind,title,visibility,evaluationId,parentId:null,status:['PROBLEM','GOAL'].includes(kind)?'CONFIRMED':'DRAFT',version:1,data},{transaction});
 await audit(req,kind+'_CREATED',transaction,pathId,record.id,1);return recordDto(req,record,access,transaction);
 });});}
export async function updateRecord(req:Request,id:string,kind:RecordKind,body:any){return sequelize.transaction(async transaction=>{
 const {record,access}=await loadClinicalRecord(req,id,transaction);if(record.kind!==kind)fail('Elemento non trovato','NOT_FOUND',404);
 await assertRecordEditable(req,record,access,transaction);expectedVersion(body.expectedVersion,record.version);
 if(medicalKinds.includes(kind)&&!doctors.includes(access.role))fail('Operazione riservata al medico','CLINICAL_ACCESS',403);
 const previousData={...record.data};if(kind==='DOCUMENT')for(const key of ['fileName','mimeType','sizeBytes','checksumSha256'])delete previousData[key];
 const data=validateRecordData(kind,body.data===undefined?previousData:kind==='DOCUMENT'?{...previousData,...body.data}:body.data);
 if(kind==='DOCUMENT'&&data.rawFileId!==record.data.rawFileId)fail('Il documento originale non può essere sostituito');
 if(kind==='FINDING')data.observationId=record.data.observationId;
 await validateLinks(req,access,kind,data,record.evaluationId,transaction,id);
 if(kind==='FINDING')await storeFindingMeasure(req,access,data,record.evaluationId!,transaction,record);
 const visibility=body.visibility===undefined?record.visibility:choice(body.visibility,['CLINICAL','OPERATIONAL'] as const,'Visibilità');
 if(medicalKinds.includes(kind)&&visibility!=='CLINICAL')fail('I documenti medici richiedono visibilità clinica');
 if(access.level==='OPERATIONAL'&&visibility!=='OPERATIONAL')fail('Visibilità non consentita');
 await record.update({title:body.title===undefined?record.title:text(body.title,'Titolo',240,true),visibility,data,version:record.version+1},{transaction});
 await audit(req,kind+'_UPDATED',transaction,record.carePathId,id,record.version);return recordDto(req,record,access,transaction);});}

export async function recordCommand(req:Request,id:string,kind:RecordKind,command:'confirm'|'cancel'|'revise',body:any){return sequelize.transaction(async transaction=>{
 const {record,access}=await loadClinicalRecord(req,id,transaction);if(record.kind!==kind)fail('Elemento non trovato','NOT_FOUND',404);
 await assertClinicalWrite(req,access,transaction,recordModule(kind,record.data,access));
 if(medicalKinds.includes(kind)&&!doctors.includes(access.role))fail('Operazione riservata al medico','CLINICAL_ACCESS',403);
 return withClinicalOperation(req,body.operationId,kind+'-'+command,{id,expectedVersion:body.expectedVersion,evaluationId:body.evaluationId??null},transaction,async()=>{
 expectedVersion(body.expectedVersion,record.version);
 if(command==='revise'){
 if(!['PROGRAM','REPORT','PRESCRIPTION'].includes(kind)||record.status!=='CONFIRMED')fail('Revisione non disponibile');
 const evaluationId=kind==='PROGRAM'?null:uuid(body.evaluationId,'Nuova valutazione')!;
 const data=clone(record.data);await validateLinks(req,access,kind,data,evaluationId,transaction);
 const revision=await ClinicalRecord.schema(req.tenantSchema!).create({carePathId:record.carePathId,patientId:record.patientId,structureId:record.structureId,authorUserId:access.userId,kind,title:record.title,visibility:record.visibility,evaluationId,parentId:record.id,status:'DRAFT',version:1,data},{transaction});
 await audit(req,kind+'_REVISED',transaction,record.carePathId,revision.id,1);return recordDto(req,revision,access,transaction);
 }
 await assertRecordEditable(req,record,access,transaction);
 if(command==='confirm'){
 if(kind==='PROGRAM'&&!record.data.items.length)fail('Aggiungi almeno una attività');
 if(kind==='SESSION'){
 const results=[...record.data.results];for(const item of record.data.programSnapshot.items){if(!results.some(r=>r.itemId===item.id))results.push({itemId:item.id,status:'NOT_RECORDED'});}
 record.data={...record.data,results};
 }}
 if(command==='cancel'&&kind==='FINDING'&&record.data.observationId){
 const observation=await Observation.schema(req.tenantSchema!).findOne({where:{id:record.data.observationId,operatorId:access.userId,evaluationId:record.evaluationId},transaction});
 if(observation?.metadata?.clinicalFinding===true)await observation.update({quality:'INVALID',metadata:{...observation.metadata,withdrawnAt:new Date().toISOString(),withdrawnByUserId:access.userId,withdrawnReason:'FINDING_CANCELLED'}},{transaction});
 }
 await record.update({status:command==='confirm'?'CONFIRMED':'CANCELLED',data:record.data,version:record.version+1},{transaction});
 await audit(req,kind+'_'+command.toUpperCase(),transaction,record.carePathId,id,record.version);return recordDto(req,record,access,transaction);
 });});}
export async function createPathEvaluation(req:Request,pathId:string,body:any){return sequelize.transaction(async transaction=>{
 const access=await loadClinicalPath(req,pathId,transaction);const setup=await assertClinicalEvaluationContext(req,{carePathId:pathId,patientId:access.path.patientId,templateVersionId:body.templateVersionId},transaction);
 return withClinicalOperation(req,body.operationId,'create-evaluation',{pathId,title:body.title??null,templateVersionId:body.templateVersionId??null},transaction,async()=>{
 const e=await Evaluation.schema(req.tenantSchema!).create({patientId:access.path.patientId,userId:access.userId,structureId:access.path.structureId,date:new Date(),title:text(body.title,'Titolo',240)??'Valutazione',status:'DRAFT',...setup},{transaction});
 await audit(req,'EVALUATION_CREATED',transaction,pathId,e.id);return {...plain(e),capabilities:{canEdit:true,lockReason:null}};
 });});}
export async function getProgress(req:Request,id:string){
 const access=await loadClinicalPath(req,id);const evaluations=await Evaluation.schema(req.tenantSchema!).findAll({where:{carePathId:id,...(access.level==='CLINICAL'?{[Op.or]:[{userId:access.userId},{status:'COMPLETED'}]}:{userId:access.userId,clinicalVisibility:'OPERATIONAL'})},attributes:['id']});
 const observations=await Observation.schema(req.tenantSchema!).findAll({where:{patientId:access.path.patientId,evaluationId:{[Op.in]:evaluations.map(e=>e.id)},quality:{[Op.ne]:'INVALID'},value:{[Op.ne]:null}},order:[['effectiveDateTime','ASC']],limit:10000});
 const groups=new Map<string,any>();
 for(const observation of observations){const o=plain(observation);const key=comparableKey(o);if(!groups.has(key))groups.set(key,{comparisonKey:key,metricCode:o.metricCode,unit:o.unit,side:o.side,method:o.calculationMethod??o.metadata?.method??o.provenance,protocol:o.metadata?.protocol??null,points:[]});groups.get(key).points.push({date:o.effectiveDateTime,value:o.value,observationId:o.id});}
 return [...groups.values()];
}
export async function getTimeline(req:Request,id:string){
 const access=await loadClinicalPath(req,id);const records=await visibleRecords(req,access);const ids=new Set(records.map(r=>r.id));
 const entries=await ClinicalAudit.schema(req.tenantSchema!).findAll({where:{carePathId:id},order:[['createdAt','DESC']],limit:1000});
 return entries.map(plain).filter(e=>!e.recordId||ids.has(e.recordId));
}
export async function listTemplates(req:Request){
 const actor=await clinicalActor(req);if(!(await getClinicalCapabilities(req)).canRead)fail('Accesso non consentito','CLINICAL_ACCESS',403);
 return EvaluationTemplate.schema(req.tenantSchema!).findAll({where:{structureId:actor.structureId,[Op.or]:[{ownerUserId:actor.userId},{scope:'STRUCTURE',status:'PUBLISHED'}]},order:[['updatedAt','DESC']]});
}
export async function createTemplate(req:Request,body:any){return sequelize.transaction(async transaction=>{
 const actor=await clinicalActor(req,transaction);const caps=await getClinicalCapabilities(req,transaction);
 if(!caps.enabled||!caps.canWrite)fail('Configuratore non disponibile','FEATURE_DISABLED',409);
 const scope=choice(body.scope,['PERSONAL','STRUCTURE'] as const,'Ambito','PERSONAL');
 if(scope==='STRUCTURE'&&actor.role!=='OWNER')fail('Solo il titolare pubblica modelli del centro','CLINICAL_ACCESS',403);
 const name=text(body.name,'Nome modello',240,true)!;const data=validateTemplate(body.data);
 return withClinicalOperation(req,body.operationId,'create-template',{name,scope,data},transaction,async()=>plain(await EvaluationTemplate.schema(req.tenantSchema!).create({structureId:actor.structureId,ownerUserId:actor.userId,name,scope,data,status:'DRAFT',version:1},{transaction})));
 });}
export async function updateTemplate(req:Request,id:string,body:any,command?:'publish'|'clone'|'archive'){return sequelize.transaction(async transaction=>{
 const actor=await clinicalActor(req,transaction);const caps=await getClinicalCapabilities(req,transaction);if(!caps.enabled||!caps.canWrite)fail('Configuratore non disponibile','FEATURE_DISABLED',409);
 const template=await loadTemplate(req,id,transaction);
 if(command==='clone')return withClinicalOperation(req,body.operationId,'clone-template',{id,expectedVersion:body.expectedVersion},transaction,async()=>{expectedVersion(body.expectedVersion,template.version);return plain(await EvaluationTemplate.schema(req.tenantSchema!).create({structureId:actor.structureId,ownerUserId:actor.userId,name:template.name+' (copia)',scope:'PERSONAL',status:'DRAFT',parentId:template.id,data:clone(template.data),version:1},{transaction}));});
 if(template.ownerUserId!==actor.userId)fail('Modello non modificabile','CLINICAL_ACCESS',403);
 if(command&&(body.data!==undefined||body.name!==undefined))fail('Modifica prima la bozza, poi esegui il comando');
 const mutate=async()=>{
 expectedVersion(body.expectedVersion,template.version);
 if(template.status==='ARCHIVED'||template.status!=='DRAFT'&&command!=='archive')fail('Crea una copia per modificare il modello pubblicato','TEMPLATE_IMMUTABLE',409);
 const data=body.data===undefined?template.data:validateTemplate(body.data);
 if(command==='publish'&&!data.items.length)fail('Il modello non contiene elementi');
 await template.update({name:body.name===undefined?template.name:text(body.name,'Nome modello',240,true),data,status:command==='publish'?'PUBLISHED':command==='archive'?'ARCHIVED':template.status,version:template.version+1},{transaction});
 return plain(template);
 };
 return command?withClinicalOperation(req,body.operationId,command+'-template',{id,expectedVersion:body.expectedVersion},transaction,mutate):mutate();
 });}
export async function getPreferences(req:Request){const actor=await clinicalActor(req);return (await EvaluationPreference.schema(req.tenantSchema!).findOne({where:{userId:actor.userId,structureId:actor.structureId}}))??{templateId:null,data:{items:[]},version:0};}
export async function savePreferences(req:Request,body:any){return sequelize.transaction(async transaction=>{
 const actor=await clinicalActor(req,transaction);const caps=await getClinicalCapabilities(req,transaction);if(!caps.enabled||!caps.canWrite)fail('Configuratore non disponibile','FEATURE_DISABLED',409);
 await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:schema), hashtext(:key))',{replacements:{schema:req.tenantSchema!,key:'preferences:'+actor.userId+':'+actor.structureId},transaction});
 const existing=await EvaluationPreference.schema(req.tenantSchema!).findOne({where:{userId:actor.userId,structureId:actor.structureId},transaction,lock:transaction.LOCK.UPDATE});
 expectedVersion(body.expectedVersion,existing?.version??0);
 const templateId=uuid(body.templateId,'Modello',false)??null;if(templateId){const t=await loadTemplate(req,templateId,transaction);if(t.status!=='PUBLISHED')fail('Modello non pubblicato');}
 const data=validateTemplate(body.data);const values={templateId,data,version:(existing?.version??0)+1};
 return existing?existing.update(values,{transaction}):EvaluationPreference.schema(req.tenantSchema!).create({userId:actor.userId,structureId:actor.structureId,...values},{transaction});
 });}

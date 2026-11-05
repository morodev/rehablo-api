import {Router,type Request,type Response} from 'express';
import {requireAuth} from '../../../middleware/auth.js';
import {resolveTenantSchema} from '../../../middleware/tenantSchema.js';
import {requireAnyPermission,requirePermission} from '../../../middleware/rbac.js';
import {asyncHandler} from '../../../utils/asyncHandler.js';
import {sendSuccessResponse} from '../../../utils/response.js';
import * as service from '../services/clinical.service.js';
import {clinicalCatalog} from '../clinical.catalog.js';
import type {RecordKind} from '../clinical.types.js';
import {fail} from '../services/clinical.policy.js';
const router=Router();
const read=requireAnyPermission(['evaluation','read'],['protocol','read']);
const write=requireAnyPermission(['evaluation','create'],['protocol','create']);
const wrap=(action:(req:Request)=>Promise<unknown>,status=200)=>asyncHandler(async(req:Request,res:Response)=>sendSuccessResponse(res,status,await action(req)));
router.get('/clinical/capabilities',requireAuth,resolveTenantSchema,requirePermission('patient','read'),wrap(req=>service.getClinicalCapabilities(req)));
router.patch('/clinical/capabilities',requireAuth,resolveTenantSchema,requirePermission('tenant','update','tenant'),wrap(req=>service.setClinicalCapabilities(req,req.body)));
const prefixes=['/care-paths','/care-problems','/care-goals','/clinical-findings','/care-programs','/clinical-sessions','/medical-visits','/medical-diagnoses','/medical-prescriptions','/medical-reports','/clinical-documents','/evaluation-templates','/evaluation-preferences','/clinical-catalog'];
router.use(prefixes,requireAuth,resolveTenantSchema);
router.get('/clinical-catalog',read,wrap(async()=>clinicalCatalog));
router.get('/care-paths',read,wrap(req=>service.listPaths(req,req.query.patientId as string|undefined)));
router.post('/care-paths',write,wrap(req=>service.createPath(req,req.body),201));
router.get('/care-paths/:id',read,wrap(req=>service.pathDetail(req,req.params.id)));
router.patch('/care-paths/:id',write,wrap(req=>service.updatePath(req,req.params.id,req.body)));
router.get('/care-paths/:id/eligible-members',read,wrap(req=>service.eligibleMembers(req,req.params.id)));
router.post('/care-paths/:id/members',write,wrap(req=>service.addMember(req,req.params.id,req.body),201));
router.delete('/care-paths/:id/members/:userId',write,wrap(req=>service.revokeMember(req,req.params.id,req.params.userId)));
router.get('/care-paths/:id/progress',read,wrap(req=>service.getProgress(req,req.params.id)));
router.get('/care-paths/:id/timeline',read,wrap(req=>service.getTimeline(req,req.params.id)));
router.post('/care-paths/:id/evaluations',write,wrap(req=>service.createPathEvaluation(req,req.params.id,req.body),201));
const resources:Array<{kind:RecordKind;collection:string;path:string}>=[
 {kind:'PROBLEM',collection:'problems',path:'care-problems'},
 {kind:'GOAL',collection:'goals',path:'care-goals'},
 {kind:'FINDING',collection:'findings',path:'clinical-findings'},
 {kind:'PROGRAM',collection:'programs',path:'care-programs'},
 {kind:'SESSION',collection:'sessions',path:'clinical-sessions'},
 {kind:'VISIT',collection:'visits',path:'medical-visits'},
 {kind:'DIAGNOSIS',collection:'diagnoses',path:'medical-diagnoses'},
 {kind:'PRESCRIPTION',collection:'prescriptions',path:'medical-prescriptions'},
 {kind:'REPORT',collection:'reports',path:'medical-reports'},
 {kind:'DOCUMENT',collection:'documents',path:'clinical-documents'}
];
for(const resource of resources){
 router.get('/care-paths/:id/'+resource.collection,read,wrap(async req=>(await service.pathDetail(req,req.params.id))[resource.collection]));
 router.post('/care-paths/:id/'+resource.collection,write,wrap(req=>service.createRecord(req,req.params.id,resource.kind,req.body),201));
 router.get('/'+resource.path+'/:id',read,wrap(async req=>{const {record,access}=await service.loadClinicalRecord(req,req.params.id);if(record.kind!==resource.kind)fail('Elemento non trovato','NOT_FOUND',404);return service.recordDto(req,record,access);}));
 router.patch('/'+resource.path+'/:id',write,wrap(req=>service.updateRecord(req,req.params.id,resource.kind,req.body)));
 for(const command of ['confirm','cancel','revise'] as const){
 if(command==='revise'&&!['PROGRAM','REPORT','PRESCRIPTION'].includes(resource.kind))continue;
 router.post('/'+resource.path+'/:id/'+command,write,wrap(req=>service.recordCommand(req,req.params.id,resource.kind,command,req.body)));
 }
}
router.get('/evaluation-templates',read,wrap(req=>service.listTemplates(req)));
router.post('/evaluation-templates',write,wrap(req=>service.createTemplate(req,req.body),201));
router.patch('/evaluation-templates/:id',write,wrap(req=>service.updateTemplate(req,req.params.id,req.body)));
for(const command of ['publish','clone','archive'] as const)router.post('/evaluation-templates/:id/'+command,write,wrap(req=>service.updateTemplate(req,req.params.id,req.body,command)));
router.get('/evaluation-preferences',read,wrap(req=>service.getPreferences(req)));
router.put('/evaluation-preferences',write,wrap(req=>service.savePreferences(req,req.body)));
export default router;

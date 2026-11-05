import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import type {RecordKind,RecordStatus,ClinicalVisibility,TemplateData} from '../clinical.types.js';
const id=()=>({type:DataTypes.UUID,defaultValue:DataTypes.UUIDV4,primaryKey:true});
const uuid=(allowNull=false)=>({type:DataTypes.UUID,allowNull});
const version=()=>({type:DataTypes.INTEGER,allowNull:false,defaultValue:1});
export class CarePath extends Model {
 declare id:string;declare patientId:string;declare structureId:string;declare ownerUserId:string;declare title:string;
 declare kind:'REHAB'|'TRAINING';declare status:'ACTIVE'|'SUSPENDED'|'COMPLETED';declare version:number;
}
CarePath.init({id:id(),patientId:uuid(),structureId:uuid(),ownerUserId:uuid(),title:{type:DataTypes.STRING(240),allowNull:false},kind:{type:DataTypes.STRING(20),allowNull:false},status:{type:DataTypes.STRING(20),allowNull:false,defaultValue:'ACTIVE'},version:version()},
 {sequelize,modelName:'carePath',tableName:'care_paths',indexes:[{fields:['patientId','structureId']}]});
export class CarePathMember extends Model {declare carePathId:string;declare userId:string;declare level:ClinicalVisibility;declare assignedByUserId:string;declare revokedAt:Date|null;}
CarePathMember.init({carePathId:{...uuid(),primaryKey:true},userId:{...uuid(),primaryKey:true},level:{type:DataTypes.STRING(20),allowNull:false},assignedByUserId:uuid(),revokedAt:{type:DataTypes.DATE,allowNull:true}},
 {sequelize,modelName:'carePathMember',tableName:'care_path_members'});
export class ClinicalRecord extends Model {
 declare id:string;declare carePathId:string;declare patientId:string;declare structureId:string;declare authorUserId:string;declare kind:RecordKind;
 declare title:string;declare status:RecordStatus;declare visibility:ClinicalVisibility;declare version:number;declare evaluationId:string|null;declare parentId:string|null;
 declare data:Record<string,any>;
}
ClinicalRecord.init({id:id(),carePathId:uuid(),patientId:uuid(),structureId:uuid(),authorUserId:uuid(),kind:{type:DataTypes.STRING(30),allowNull:false},title:{type:DataTypes.STRING(240),allowNull:false},status:{type:DataTypes.STRING(20),allowNull:false,defaultValue:'DRAFT'},visibility:{type:DataTypes.STRING(20),allowNull:false,defaultValue:'CLINICAL'},version:version(),evaluationId:uuid(true),parentId:uuid(true),data:{type:DataTypes.JSONB,allowNull:false,defaultValue:{}}},
 {sequelize,modelName:'clinicalRecord',tableName:'clinical_records',indexes:[{fields:['carePathId','kind']},{fields:['evaluationId']},{fields:['authorUserId']}]});
export class EvaluationTemplate extends Model {declare id:string;declare structureId:string;declare ownerUserId:string;declare name:string;declare scope:'PERSONAL'|'STRUCTURE';declare status:'DRAFT'|'PUBLISHED'|'ARCHIVED';declare version:number;declare parentId:string|null;declare data:TemplateData;}
EvaluationTemplate.init({id:id(),structureId:uuid(),ownerUserId:uuid(),name:{type:DataTypes.STRING(240),allowNull:false},scope:{type:DataTypes.STRING(20),allowNull:false,defaultValue:'PERSONAL'},status:{type:DataTypes.STRING(20),allowNull:false,defaultValue:'DRAFT'},version:version(),parentId:uuid(true),data:{type:DataTypes.JSONB,allowNull:false,defaultValue:{items:[]}}},
 {sequelize,modelName:'clinicalEvaluationTemplate',tableName:'clinical_evaluation_templates',indexes:[{fields:['structureId','ownerUserId']}]});
export class EvaluationPreference extends Model {declare userId:string;declare structureId:string;declare version:number;declare templateId:string|null;declare data:TemplateData;}
EvaluationPreference.init({userId:{...uuid(),primaryKey:true},structureId:{...uuid(),primaryKey:true},templateId:uuid(true),version:version(),data:{type:DataTypes.JSONB,allowNull:false,defaultValue:{items:[]}}},
 {sequelize,modelName:'clinicalEvaluationPreference',tableName:'clinical_evaluation_preferences'});
export class ClinicalOperation extends Model {declare operationId:string;declare userId:string;declare fingerprint:string;declare result:unknown;}
ClinicalOperation.init({operationId:{...uuid(),primaryKey:true},userId:{...uuid(),primaryKey:true},fingerprint:{type:DataTypes.STRING(64),allowNull:false},result:{type:DataTypes.JSONB,allowNull:false}},
 {sequelize,modelName:'clinicalOperation',tableName:'clinical_operations'});
export class ClinicalAudit extends Model {}
ClinicalAudit.init({id:id(),carePathId:uuid(true),recordId:uuid(true),actorUserId:uuid(),action:{type:DataTypes.STRING(80),allowNull:false},version:{type:DataTypes.INTEGER,allowNull:true}},
 {sequelize,modelName:'clinicalAudit',tableName:'clinical_audit',updatedAt:false,indexes:[{fields:['carePathId','createdAt']}]});
export class ClinicalPublication extends Model {declare id:string;declare recordId:string;declare patientId:string;declare carePathId:string;declare structureId:string;declare publishedBy:string;declare publishedAt:Date;declare revokedAt:Date|null;declare sourceVersion:number;}
ClinicalPublication.init({id:id(),recordId:uuid(),patientId:uuid(),carePathId:uuid(),structureId:uuid(),publishedBy:uuid(),publishedAt:{type:DataTypes.DATE,allowNull:false,defaultValue:DataTypes.NOW},revokedAt:{type:DataTypes.DATE,allowNull:true},sourceVersion:{type:DataTypes.INTEGER,allowNull:false}},
 {sequelize,modelName:'clinicalPublication',tableName:'clinical_publications',indexes:[{fields:['recordId'],unique:true},{fields:['patientId']}]});
export class ClinicalHomeFeedback extends Model {declare id:string;declare publicationId:string;declare recordId:string;declare patientId:string;declare carePathId:string;declare actorUserId:string;declare operationId:string;declare data:Record<string,unknown>;}
ClinicalHomeFeedback.init({id:id(),publicationId:uuid(),recordId:uuid(),patientId:uuid(),carePathId:uuid(),actorUserId:uuid(),operationId:uuid(),data:{type:DataTypes.JSONB,allowNull:false}},
 {sequelize,modelName:'clinicalHomeFeedback',tableName:'clinical_home_feedback',indexes:[{fields:['actorUserId','operationId'],unique:true},{fields:['publicationId']}]});
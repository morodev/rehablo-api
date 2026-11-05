export const CLINICAL_GROUPS = ['SYMPTOMS','MOVEMENT','STRENGTH','CONTROL','FUNCTION','TESTS'] as const;
export type ClinicalGroup = typeof CLINICAL_GROUPS[number];
export type ClinicalVisibility = 'CLINICAL' | 'OPERATIONAL';
export type RecordKind = 'PROBLEM' | 'GOAL' | 'FINDING' | 'PROGRAM' | 'SESSION' | 'VISIT' | 'DIAGNOSIS' | 'PRESCRIPTION' | 'REPORT' | 'DOCUMENT';
export type RecordStatus = 'DRAFT' | 'CONFIRMED' | 'ARCHIVED' | 'CANCELLED';
export interface TemplateItem {code:string;group:ClinicalGroup;label:string;visibility:'PRIMARY'|'DETAIL'|'CATALOG';order:number;fields:string[];method?:string;}
export interface TemplateData {items:TemplateItem[];}
export interface ProgramItem {id:string;category:'MANUAL_THERAPY'|'INSTRUMENTAL_THERAPY'|'EXERCISE'|'EDUCATION';title:string;exerciseId?:string;day?:string;block?:string;side?:string;sets?:number;reps?:number;durationSeconds?:number;distance?:number;load?:number;loadUnit?:string;loadMode?:'TOTAL'|'PER_SIDE'|'PER_DUMBBELL'|'MACHINE'|'DESCRIPTION';loadDescription?:string;restSeconds?:number;instructions?:string;}
export interface SessionResult {itemId:string;status:'NOT_RECORDED'|'IN_PROGRESS'|'PERFORMED'|'PARTIAL'|'INTERRUPTED'|'NOT_PERFORMED';replacement?:string;sets?:Array<{reps?:number;load?:number;durationSeconds?:number;distance?:number}>;pain?:number;effort?:number;notes?:string;}
export interface ClinicalCapabilities {enabled:boolean;medicalEnabled:boolean;trainingEnabled:boolean;canManage:boolean;canRead:boolean;canWrite:boolean;integrations:{ai:false;dictation:false;directDevices:false};}
export interface ClinicalRecordData {
 PROBLEM:{region?:string;side?:string;onset?:string;description?:string;domains?:string[];priority?:number};
 GOAL:{description?:string;metricCode?:string;baselineObservationId?:string;target?:number;unit?:string;dueDate?:string;state?:'NOT_STARTED'|'IN_PROGRESS'|'ACHIEVED'|'SUSPENDED'|'ARCHIVED'};
 FINDING:{problemId?:string;code:string;label?:string;source:'PATIENT'|'CAREGIVER'|'PROFESSIONAL'|'DOCUMENT'|'DEVICE';collectionState:'NOT_COLLECTED'|'PRESENT'|'ABSENT'|'UNCERTAIN'|'NOT_ASSESSABLE'|'DECLINED';intensity?:number|null;scale?:'0_10'|'0_100';unit?:string;side?:string;region?:string;method?:string;notes?:string;observationId?:string;bodyPoint?:{x:number;y:number;view:'front'|'back'}};
 PROGRAM:{discipline:'PHYSIO'|'PT';items:ProgramItem[];objectiveIds?:string[];instructions?:string;frequency?:string};
 SESSION:{programId:string;programSnapshot?:unknown;results:SessionResult[];notes?:string;startedAt?:string;endedAt?:string;state?:'IN_PROGRESS'|'PAUSED'|'TO_CONFIRM'};
 VISIT:{reason:string;history?:string;examination?:string;conclusion?:string;followUpDate?:string};
 DIAGNOSIS:{visitId?:string;problemId?:string;description:string;certainty:'SUSPECTED'|'CONFIRMED'|'TO_CLARIFY';code?:string;codingSystem?:string;codingVersion?:string;side?:string};
 PRESCRIPTION:{visitId?:string;type:'MEDICATION'|'REHABILITATION'|'EXAMINATION'|'CONSULTATION'|'AID';description:string;instructions?:string};
 REPORT:{visitId?:string;text:string};
 DOCUMENT:{rawFileId:string;documentType:'DOCUMENT'|'PHOTO'|'VIDEO';source?:string;reviewStatus:'UNREAD'|'READ'|'VERIFIED';problemId?:string};
}
export interface ClinicalIntegrationProposal {id:string;sourceId:string;sourceText:string;status:'PENDING'|'ACCEPTED'|'REJECTED';fields:Record<string,unknown>;}
export interface ClinicalExtractionAdapter {extract(input:{text:string;documentId?:string}):Promise<ClinicalIntegrationProposal[]>;}
export interface ClinicalDeviceAdapter {acquire(input:{patientId:string;evaluationId:string;protocol:string}):Promise<unknown[]>;}

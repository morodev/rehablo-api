import {CLINICAL_GROUPS, type RecordKind, type TemplateData} from '../clinical.types.js';
export class ClinicalError extends Error {constructor(public statusCode:number,message:string,public code='CLINICAL_VALIDATION'){super(message);}}
export function fail(message:string,code='CLINICAL_VALIDATION',statusCode=400):never {throw new ClinicalError(statusCode,message,code);}
export function object(value:unknown):Record<string,any> {if(!value||typeof value!=='object'||Array.isArray(value))fail('Oggetto non valido');return value as Record<string,any>;}
export function text(value:unknown,label:string,max=4000,required=false):string|undefined {
 if(value===undefined||value===null){if(required)fail(label+' obbligatorio');return undefined;}
 if(typeof value!=='string'||value.length>max||(required&&!value.trim()))fail(label+' non valido');return value.trim();
}
export function uuid(value:unknown,label='Identificativo',required=true):string|undefined {
 if((value===undefined||value===null||value==='')&&!required)return undefined;
 if(typeof value!=='string'||!/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(value))fail(label+' non valido');return value;
}
export function choice<T extends string>(value:unknown,values:readonly T[],label:string,fallback?:T):T {
 if(value===undefined&&fallback!==undefined)return fallback;if(typeof value!=='string'||!values.includes(value as T))fail(label+' non valido');return value as T;
}
export function numeric(value:unknown,label:string,min=-Infinity,max=Infinity):number|undefined {
 if(value===undefined||value===null)return undefined;if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)fail(label+' non valido');return value;
}
function strings(value:unknown,label:string):string[]|undefined{if(value===undefined)return undefined;if(!Array.isArray(value)||value.length>100||value.some(x=>typeof x!=='string'||x.length>200))fail(label+' non valido');return value;}
function keep(data:Record<string,any>,keys:string[]):Record<string,any>{
 const unsupported=Object.keys(data).filter(k=>!keys.includes(k));if(unsupported.length)fail('Campi non ammessi: '+unsupported.join(', '));
 const result:Record<string,any>={};for(const k of keys)if(data[k]!==undefined)result[k]=data[k];return result;
}
function date(value:unknown,label:string){if(value===undefined||value===null||value==='')return undefined;if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))fail(label+' non valida');return value;}
export function expectedVersion(value:unknown,current:number){if(!Number.isInteger(value)||value!==current)fail('Il dato è stato modificato. Ricarica prima di salvare.','VERSION_CONFLICT',409);}
export function validateTemplate(value:unknown):TemplateData {
 const data=object(value);if(!Array.isArray(data.items)||data.items.length>300)fail('Elementi del modello non validi');const seen=new Set<string>();
 return {items:data.items.map((raw:any,index:number)=>{
 const item=object(raw);const code=text(item.code,'Codice',120,true)!;if(seen.has(code))fail('Elemento ripetuto nel modello');seen.add(code);
 return {code,label:text(item.label,'Etichetta',180,true)!,group:choice(item.group,CLINICAL_GROUPS,'Gruppo'),visibility:choice(item.visibility,['PRIMARY','DETAIL','CATALOG'] as const,'Visibilità'),order:numeric(item.order,'Ordine',0,10000)??index,fields:strings(item.fields,'Campi')??[],...(item.method?{method:text(item.method,'Metodo',200)}:{})};
 })};
}
const sides=['LEFT','RIGHT','BILATERAL','CENTRAL','NA','UNKNOWN'] as const;
export function validateRecordData(kind:RecordKind,value:unknown):Record<string,any>{
 const data=object(value);
 switch(kind){
 case 'PROBLEM':{
 const v=keep(data,['region','side','onset','description','domains','priority']);
 return {...v,region:text(v.region,'Sede',160),side:v.side===undefined?undefined:choice(v.side,sides,'Lato'),onset:text(v.onset,'Esordio',200),description:text(v.description,'Descrizione'),domains:strings(v.domains,'Ambiti'),priority:numeric(v.priority,'Priorità',0,100)};
 }
 case 'GOAL':{
 const v=keep(data,['description','metricCode','baselineObservationId','target','unit','dueDate','state']);
 return {...v,description:text(v.description,'Descrizione'),metricCode:text(v.metricCode,'Parametro',160),baselineObservationId:uuid(v.baselineObservationId,'Misura iniziale',false),target:numeric(v.target,'Obiettivo'),unit:text(v.unit,'Unità',80),dueDate:date(v.dueDate,'Scadenza'),state:choice(v.state,['NOT_STARTED','IN_PROGRESS','ACHIEVED','SUSPENDED','ARCHIVED'],'Stato obiettivo','NOT_STARTED')};
 }
 case 'FINDING':{
 const v=keep(data,['problemId','code','label','source','collectionState','intensity','scale','unit','side','region','method','notes','observationId','bodyPoint']);
 const scale=choice(v.scale,['0_10','0_100'] as const,'Scala','0_10');const intensity=numeric(v.intensity,'Intensità',0,scale==='0_10'?10:100);
 const state=choice(v.collectionState,['NOT_COLLECTED','PRESENT','ABSENT','UNCERTAIN','NOT_ASSESSABLE','DECLINED'],'Stato');
 if(['NOT_COLLECTED','NOT_ASSESSABLE','DECLINED'].includes(state)&&(intensity!==undefined||v.observationId))fail('Una rilevazione non raccolta non può avere un risultato');
 let point;if(v.bodyPoint){const p=object(v.bodyPoint);point={x:numeric(p.x,'Posizione X',0,1),y:numeric(p.y,'Posizione Y',0,1),view:choice(p.view,['front','back'],'Vista')};if(point.x===undefined||point.y===undefined)fail('Coordinate mancanti');}
 return {problemId:uuid(v.problemId,'Problema',false),code:text(v.code,'Codice',160,true),label:text(v.label,'Etichetta',180),source:choice(v.source,['PATIENT','CAREGIVER','PROFESSIONAL','DOCUMENT','DEVICE'],'Fonte'),collectionState:state,intensity:intensity??null,scale,unit:text(v.unit,'Unità',80),side:v.side===undefined?undefined:choice(v.side,sides,'Lato'),region:text(v.region,'Sede',160),method:text(v.method,'Metodo',200),notes:text(v.notes,'Note'),observationId:uuid(v.observationId,'Rilevazione',false),bodyPoint:point};
 }
 case 'PROGRAM':{
 const v=keep(data,['discipline','items','objectiveIds','instructions','frequency']);const discipline=choice(v.discipline,['PHYSIO','PT'],'Professione');
 if(!Array.isArray(v.items)||v.items.length>300)fail('Attività non valide');const ids=new Set<string>();
 const items=v.items.map((raw:any)=>{const item=keep(object(raw),['id','category','title','exerciseId','day','block','side','sets','reps','durationSeconds','distance','load','loadUnit','loadMode','loadDescription','restSeconds','instructions']);
 const id=uuid(item.id,'Attività')!;if(ids.has(id))fail('Attività ripetuta');ids.add(id);
 const category=choice(item.category,['MANUAL_THERAPY','INSTRUMENTAL_THERAPY','EXERCISE','EDUCATION'],'Categoria');
 if(discipline==='PT'&&['MANUAL_THERAPY','INSTRUMENTAL_THERAPY'].includes(category))fail('Categoria non disponibile al personal trainer');
 const result:any={id,category,title:text(item.title,'Nome attività',240,true),exerciseId:uuid(item.exerciseId,'Esercizio',false)};
 for(const k of ['day','block','side','loadUnit','loadDescription','instructions'])result[k]=text(item[k],k,k==='instructions'?4000:240);
 for(const k of ['sets','reps','durationSeconds','distance','load','restSeconds'])result[k]=numeric(item[k],k,0);
 if(item.loadMode!==undefined)result.loadMode=choice(item.loadMode,['TOTAL','PER_SIDE','PER_DUMBBELL','MACHINE','DESCRIPTION'],'Tipo di carico');
 if(result.load!==undefined&&(!result.loadUnit||!result.loadMode))fail('Il carico richiede unità e modalità');return result;
 });
 return {discipline,items,objectiveIds:strings(v.objectiveIds,'Obiettivi'),instructions:text(v.instructions,'Istruzioni'),frequency:text(v.frequency,'Frequenza',200)};
 }
 case 'SESSION':{
 const v=keep(data,['programId','programSnapshot','results','notes','startedAt','endedAt','state']);
 if(!Array.isArray(v.results)||v.results.length>300)fail('Risultati non validi');const ids=new Set<string>();
 const results=v.results.map((raw:any)=>{const r=keep(object(raw),['itemId','status','replacement','sets','pain','effort','notes']);
 const itemId=uuid(r.itemId,'Attività')!;if(ids.has(itemId))fail('Attività ripetuta');ids.add(itemId);
 const status=choice(r.status,['NOT_RECORDED','IN_PROGRESS','PERFORMED','PARTIAL','INTERRUPTED','NOT_PERFORMED'],'Esecuzione');
 if(r.sets!==undefined&&(!Array.isArray(r.sets)||r.sets.length>200))fail('Serie non valide');
 const sets=r.sets?.map((s:any)=>{s=keep(object(s),['reps','load','durationSeconds','distance']);return Object.fromEntries(Object.entries(s).map(([k,val])=>[k,numeric(val,k,0)]));});
 if(['NOT_RECORDED','NOT_PERFORMED'].includes(status)&&sets?.length)fail('Serie registrate richiedono uno stato di esecuzione');
 return {itemId,status,sets,replacement:text(r.replacement,'Sostituzione',240),pain:numeric(r.pain,'Dolore',0,10),effort:numeric(r.effort,'Sforzo',0,10),notes:text(r.notes,'Note')};});
 return {programId:uuid(v.programId,'Programma'),results,notes:text(v.notes,'Note'),startedAt:date(v.startedAt,'Inizio'),endedAt:date(v.endedAt,'Fine'),state:choice(v.state,['IN_PROGRESS','PAUSED','TO_CONFIRM'],'Stato seduta','IN_PROGRESS')};
 }
 case 'VISIT':{const v=keep(data,['reason','history','examination','conclusion','followUpDate']);return {reason:text(v.reason,'Motivo',4000,true),history:text(v.history,'Anamnesi',12000),examination:text(v.examination,'Esame',12000),conclusion:text(v.conclusion,'Conclusione',12000),followUpDate:date(v.followUpDate,'Controllo')};}
 case 'DIAGNOSIS':{const v=keep(data,['visitId','problemId','description','certainty','code','codingSystem','codingVersion','side']);return {...v,visitId:uuid(v.visitId,'Visita',false),problemId:uuid(v.problemId,'Problema',false),description:text(v.description,'Diagnosi',12000,true),certainty:choice(v.certainty,['SUSPECTED','CONFIRMED','TO_CLARIFY'],'Certezza'),code:text(v.code,'Codice',160),codingSystem:text(v.codingSystem,'Sistema',160),codingVersion:text(v.codingVersion,'Versione',80),side:v.side===undefined?undefined:choice(v.side,sides,'Lato')};}
 case 'PRESCRIPTION':{const v=keep(data,['visitId','type','description','instructions']);return {visitId:uuid(v.visitId,'Visita',false),type:choice(v.type,['MEDICATION','REHABILITATION','EXAMINATION','CONSULTATION','AID'],'Prescrizione'),description:text(v.description,'Descrizione',12000,true),instructions:text(v.instructions,'Istruzioni',12000)};}
 case 'REPORT':{const v=keep(data,['visitId','text']);return {visitId:uuid(v.visitId,'Visita',false),text:text(v.text,'Referto',60000,true)};}
 case 'DOCUMENT':{const v=keep(data,['rawFileId','documentType','source','reviewStatus','problemId']);return {rawFileId:uuid(v.rawFileId,'File'),documentType:choice(v.documentType,['DOCUMENT','PHOTO','VIDEO'],'Tipo documento'),source:text(v.source,'Fonte',240),reviewStatus:choice(v.reviewStatus,['UNREAD','READ','VERIFIED'],'Verifica','UNREAD'),problemId:uuid(v.problemId,'Problema',false)};}
 }
}
export function mayReadRecord(record:{authorUserId:string;visibility:string;status:string},userId:string,level:string):boolean{
 if(record.visibility==='CLINICAL'&&level!=='CLINICAL')return false;
 if(record.authorUserId===userId)return true;return record.status==='CONFIRMED'&&(record.visibility==='OPERATIONAL'||level==='CLINICAL');
}
export function assertPathTransition(current:string,next:string){if(current===next)return;if(!({ACTIVE:['SUSPENDED','COMPLETED'],SUSPENDED:['ACTIVE','COMPLETED'],COMPLETED:[]} as Record<string,string[]>)[current]?.includes(next))fail('Transizione del percorso non consentita','INVALID_STATE',409);}
export function comparableKey(observation:any):string{return JSON.stringify([observation.metricCode,observation.unit,observation.side,observation.metadata?.protocol??null,observation.metadata?.protocolVersion??null,observation.calculationMethod??null,observation.metadata?.method??null,observation.aggregation??null,observation.provenance,observation.sourceId??null,observation.metadata?.source??null,observation.metadata?.clinicalSide??null]);}

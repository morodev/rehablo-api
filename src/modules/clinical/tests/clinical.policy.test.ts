import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRecordData,validateTemplate,expectedVersion,mayReadRecord,assertPathTransition,comparableKey} from '../services/clinical.policy.js';
const id='11111111-1111-4111-8111-111111111111';
test('missing severity remains absent while explicit zero remains a measurement',()=>{
 const data={code:'pain',source:'PATIENT',collectionState:'PRESENT'};
 assert.equal(validateRecordData('FINDING',data).intensity,null);
 assert.equal(validateRecordData('FINDING',{...data,intensity:0}).intensity,0);
 assert.throws(()=>validateRecordData('FINDING',{...data,collectionState:'NOT_COLLECTED',intensity:0}));
});
test('numeric string and non-finite intensity are not silently converted',()=>{
 for(const intensity of ['0',NaN,Infinity,-1,11])assert.throws(()=>validateRecordData('FINDING',{code:'pain',source:'PATIENT',collectionState:'PRESENT',intensity}));
 assert.equal(validateRecordData('FINDING',{code:'pain',source:'PATIENT',collectionState:'PRESENT',intensity:80,scale:'0_100'}).intensity,80);
});
test('reported and observed source remain separate and uncertain does not become absent',()=>{
 const data=validateRecordData('FINDING',{code:'swelling',source:'PROFESSIONAL',collectionState:'UNCERTAIN'});
 assert.equal(data.source,'PROFESSIONAL');assert.equal(data.collectionState,'UNCERTAIN');
});
test('caller cannot inject ownership, evaluation or publication into clinical data',()=>{
 for(const key of ['authorUserId','patientId','evaluationId','publishedToPatient'])assert.throws(()=>validateRecordData('PROBLEM',{description:'Test',[key]:id}));
});
test('body points require normalized coordinates and an explicit view',()=>{
 assert.throws(()=>validateRecordData('FINDING',{code:'pain',source:'PATIENT',collectionState:'PRESENT',bodyPoint:{x:3,y:0.5,view:'front'}}));
 assert.deepEqual(validateRecordData('FINDING',{code:'pain',source:'PATIENT',collectionState:'PRESENT',bodyPoint:{x:0.4,y:0.7,view:'back'}}).bodyPoint,{x:0.4,y:0.7,view:'back'});
});
test('programs preserve unambiguous load semantics and do not add medical therapies to PT',()=>{
 assert.throws(()=>validateRecordData('PROGRAM',{discipline:'PT',items:[{id,title:'Esercizio',category:'EXERCISE',load:12}]}));
 assert.throws(()=>validateRecordData('PROGRAM',{discipline:'PT',items:[{id,title:'Terapia',category:'MANUAL_THERAPY'}]}));
 const item=validateRecordData('PROGRAM',{discipline:'PT',items:[{id,title:'Esercizio',category:'EXERCISE',load:12,loadUnit:'kg',loadMode:'PER_DUMBBELL'}]}).items[0];
 assert.equal(item.load,12);assert.equal(item.loadMode,'PER_DUMBBELL');
});
test('a planned activity is not recorded as performed and missing effort is not zero',()=>{
 const result=validateRecordData('SESSION',{programId:id,results:[{itemId:id,status:'NOT_RECORDED'}]}).results[0];
 assert.equal(result.status,'NOT_RECORDED');assert.equal(result.effort,undefined);assert.equal(result.pain,undefined);
 assert.throws(()=>validateRecordData('SESSION',{programId:id,results:[{itemId:id,status:'NOT_PERFORMED',sets:[{reps:10}]}]}));
});
test('session does not trust a caller-supplied program snapshot',()=>{
 const data=validateRecordData('SESSION',{programId:id,programSnapshot:{items:[{malicious:true}]},results:[]});assert.equal(data.programSnapshot,undefined);
});
test('repeated activity identifiers cannot overwrite separate results',()=>{
 assert.throws(()=>validateRecordData('SESSION',{programId:id,results:[{itemId:id,status:'PERFORMED'},{itemId:id,status:'PARTIAL'}]}));
});
test('template visibility is independent from actual responses and duplicates are rejected',()=>{
 const item={code:'pain',label:'Dolore',group:'SYMPTOMS',visibility:'PRIMARY',order:0,fields:['intensity']};
 assert.equal(validateTemplate({items:[item]}).items[0].visibility,'PRIMARY');
 assert.throws(()=>validateTemplate({items:[item,item]}));
 assert.throws(()=>validateTemplate({items:[{...item,visibility:'MANDATORY'}]}));
});
test('version conflicts and completed path transitions are explicit',()=>{
 assert.throws(()=>expectedVersion(2,3),(e:any)=>e.statusCode===409);
 assert.throws(()=>expectedVersion(undefined,1));assert.doesNotThrow(()=>expectedVersion(3,3));
 assert.doesNotThrow(()=>assertPathTransition('SUSPENDED','ACTIVE'));assert.throws(()=>assertPathTransition('COMPLETED','ACTIVE'));
});
test('a team member cannot read another professional draft or PT clinical content',()=>{
 const record={authorUserId:id,visibility:'CLINICAL',status:'DRAFT'};
 assert.equal(mayReadRecord(record,'other','CLINICAL'),false);
 assert.equal(mayReadRecord({...record,status:'CONFIRMED'},'other','CLINICAL'),true);
 assert.equal(mayReadRecord({...record,status:'CONFIRMED'},'other','OPERATIONAL'),false);
 assert.equal(mayReadRecord({...record,status:'CONFIRMED',visibility:'OPERATIONAL'},'other','OPERATIONAL'),true);
});
test('progress never merges different sides, units, sources or protocols',()=>{
 const base={metricCode:'force',unit:'N',side:'LEFT',provenance:'MANUAL',metadata:{protocol:'p',protocolVersion:'1'}};
 for(const other of [{...base,side:'RIGHT'},{...base,unit:'kg'},{...base,provenance:'DEVICE_API'},{...base,metadata:{protocol:'p',protocolVersion:'2'}}])assert.notEqual(comparableKey(base),comparableKey(other));
});
test('diagnosis uncertainty and internal prescription type are required',()=>{
 assert.throws(()=>validateRecordData('DIAGNOSIS',{description:'Da approfondire'}));
 assert.equal(validateRecordData('DIAGNOSIS',{description:'Da approfondire',certainty:'TO_CLARIFY'}).certainty,'TO_CLARIFY');
 assert.throws(()=>validateRecordData('PRESCRIPTION',{type:'ELECTRONIC_SIGNED',description:'Test'}));
});

test('progress separates manual collection methods and aggregation protocols',()=>{
 const first={metricCode:'strength',unit:'N',side:'LEFT',provenance:'MANUAL',aggregation:'BEST',metadata:{method:'seated'}};
 assert.notEqual(comparableKey(first),comparableKey({...first,metadata:{method:'standing'}}));
 assert.notEqual(comparableKey(first),comparableKey({...first,aggregation:'MEAN'}));
});

test('not-collected finding cannot pretend to contain an existing quantitative result',()=>{
 assert.throws(()=>validateRecordData('FINDING',{code:'pain',source:'DEVICE',collectionState:'NOT_COLLECTED',observationId:'11111111-1111-4111-8111-111111111111'}),/non raccolta/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {detectClinicalMime,clinicalFilename,validateHomeFeedback,canPublishClinicalRecord,publicClinicalData} from './clinicalMedia.policy.js';
import {renderClinicalPdf} from './clinicalPdf.service.js';
test('clinical upload detects bytes, never a client extension',()=>{
 assert.equal(detectClinicalMime(Buffer.from('<script>alert(1)</script>')),null);
 assert.equal(detectClinicalMime(Buffer.from('%PDF-1.7 test')),'application/pdf');
 assert.equal(detectClinicalMime(Buffer.from([137,80,78,71,13,10,26,10])),'image/png');
 assert.equal(clinicalFilename('../folder/private\u000a.pdf'),'private.pdf');
});
test('missing home measurements remain null and explicit zero survives',()=>{
 assert.deepEqual(validateHomeFeedback({status:'PARTIAL'}),{status:'PARTIAL',pain:null,effort:null,notes:null,source:'PATIENT'});
 assert.equal(validateHomeFeedback({status:'PERFORMED',pain:0}).pain,0);
 for(const pain of ['',false,'0',-1,11,NaN])assert.throws(()=>validateHomeFeedback({status:'PERFORMED',pain}));
});
test('only confirmed supported records can be published',()=>{
 for(const kind of ['PROGRAM','REPORT','DOCUMENT']){
  assert.equal(canPublishClinicalRecord({kind,status:'CONFIRMED'}),true);
  assert.equal(canPublishClinicalRecord({kind,status:'DRAFT'}),false);
 }
 assert.equal(canPublishClinicalRecord({kind:'DIAGNOSIS',status:'CONFIRMED'}),false);
});
test('patient projection strips clinical references, raw paths, review notes',()=>{
 const output=publicClinicalData('PROGRAM',{instructions:'Home',objectiveIds:['private'],notes:'private',items:[{id:'1',title:'Exercise',problemId:'private',notes:'private',reps:0}]});
 assert.equal(output.objectiveIds,undefined);
 assert.deepEqual(output.items,[{id:'1',title:'Exercise',reps:0}]);
 assert.equal(publicClinicalData('DOCUMENT',{rawFileId:'secret',storagePath:'secret',documentType:'PHOTO'}).rawFileId,undefined);
});
test('PDF is real, paginated for long reports, and rejects drafts',async()=>{
 await assert.rejects(renderClinicalPdf({title:'Draft',text:'',patientName:'Test',authorName:'Test',recordId:'id',version:1,createdAt:'2026-11-05',confirmed:false}));
 const pdf=await renderClinicalPdf({title:'Referto',text:'Test clinico di esempio. '.repeat(1200),patientName:'Paziente test',authorName:'Medico test',recordId:'record-test',version:2,createdAt:'2026-11-05',confirmed:true});
 assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
 assert.ok((pdf.toString('latin1').match(/\/Type \/Page\b/g)??[]).length>1);
 assert.ok(pdf.subarray(-20).toString().includes('%%EOF'));
});

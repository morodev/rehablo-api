import assert from 'node:assert/strict';
import test from 'node:test';
import type {Sequelize,Transaction} from 'sequelize';
import {migrateClinicalWorkspace,provisionTenantSchema,reconcileTenantSchemas,requiredMigrationNames} from '../../../database/standardMigrations.js';
import {migrateClinicalTenant} from '../services/clinical.migration.js';
const release='202611050001-clinical-workspace.js';
const schema='rehablo_11111111111141118111111111111111';
function fixture(fails=false){
 const names=new Set<string>(requiredMigrationNames.filter(n=>n!==release));
 const transaction={} as Transaction;const calls:string[]=[];let publicCommitted=false;let transactionNumber=0;
 const database={getQueryInterface:()=>({sequelize:database}),transaction:async(work:any)=>{const number=++transactionNumber;const result=await work(transaction);if(number===1)publicCommitted=true;return result;},query:async(sql:string,options:any={})=>{
 calls.push(sql);
 if(sql.includes('FROM pg_type t'))return [{schema_name:'public',type_name:'enum_tenant_users_role'},{schema_name:'public',type_name:'enum_structure_users_role'}];
 if(sql==='SELECT id FROM public.tenants ORDER BY id'){assert.equal(publicCommitted,true);return [[{id:'11111111-1111-4111-8111-111111111111'}]];}
 if(sql.includes('SELECT t.id, c.oid IS NOT NULL'))return [[{id:'11111111-1111-4111-8111-111111111111',hasMetadata:true}]];
 if(sql.includes('to_regclass'))return [[{registry:schema+'.SequelizeMeta'}]];
 if(sql.startsWith('SELECT name FROM public.'))return [requiredMigrationNames.map(name=>({name}))];
 if(sql.startsWith('SELECT name FROM'))return [[...names].map(name=>({name}))];
 if(!sql.startsWith('SELECT'))assert.equal(options.transaction,transaction);
 if(fails&&sql.includes('CREATE TABLE IF NOT EXISTS')&&sql.includes('clinical_records'))throw new Error('clinical table unavailable');
 if(sql.startsWith('INSERT INTO')&&options.replacements?.name)names.add(options.replacements.name);
 return [[]];
 }} as unknown as Sequelize;
 return {database,names,calls,transaction};
}
test('clinical release is additive, preserves severity history, and is idempotent',async()=>{
 const f=fixture();await migrateClinicalWorkspace(f.database);assert.ok(f.names.has(release));
 assert.ok(f.calls.some(s=>s.includes("ADD VALUE IF NOT EXISTS 'UNSPECIFIED'")));
 assert.ok(f.calls.some(s=>s.includes('human_body_symptoms ALTER COLUMN value DROP NOT NULL')));
 assert.ok(f.calls.some(s=>s.includes('human_body_areas')&&s.includes('symptom JSONB')));
 const testStorage=f.calls.find(s=>s.includes('ALTER TABLE')&&s.includes('.test_instances'));
 assert.ok(testStorage?.includes('ADD COLUMN IF NOT EXISTS "humanBodyPointId" UUID REFERENCES'));
 assert.ok(testStorage?.includes('ADD COLUMN IF NOT EXISTS "testSnapshot" JSONB'));
 assert.ok(!testStorage?.includes('CASCADE')&&!testStorage?.includes('NOT NULL'));
 assert.ok(f.calls.some(s=>s.includes('clinical_home_feedback')&&s.includes('UNIQUE("actorUserId","operationId")')));
 assert.ok(f.calls.every(s=>!/^\s*(UPDATE|DELETE|DROP TABLE|DROP SCHEMA)\b/i.test(s)));
 f.calls.length=0;await migrateClinicalWorkspace(f.database);
 assert.ok(f.calls.every(s=>!s.includes('CREATE TABLE IF NOT EXISTS')||s.includes('SequelizeMeta')));
 assert.ok(!f.calls.some(s=>s.includes('clinical_records')));
});
test('failed clinical migration never records a successful release',async()=>{
 const f=fixture(true);await assert.rejects(migrateClinicalWorkspace(f.database),/clinical table unavailable/);assert.equal(f.names.has(release),false);
});
test('tenant provisioning and reconciliation include clinical storage and do not rerun it',async()=>{
 const f=fixture();await provisionTenantSchema(f.database,schema,f.transaction);assert.ok(f.names.has(release));
 const old=fixture();assert.equal(await reconcileTenantSchemas(old.database),1);assert.ok(old.names.has(release));assert.equal(await reconcileTenantSchemas(old.database),0);
});
test('untrusted schema is rejected before executing migration SQL',async()=>{
 const db={query:()=>assert.fail('No SQL should execute')} as unknown as Sequelize;
 for(const invalid of ['public','rehablo_test','rehablo_11111111111141118111111111111111"; SELECT 1'])await assert.rejects(migrateClinicalTenant(db,invalid,{} as Transaction),/Invalid tenant schema/);
});
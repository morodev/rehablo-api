import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const migration=require('../../../../migrations/20261009-structure-calendars.js');
it('public backfill is transactional, preserves legacy rows and skips completed migration on repeated boot', async()=>{
 const queries:string[]=[];let applied=false;const tx={};
 const db={transaction:async(fn:any)=>fn(tx),query:async(sql:string,options:any)=>{
   assert.equal(options.transaction,tx);queries.push(sql);
   if(sql.startsWith('SELECT version'))return [applied?[{version:'done'}]:[]];
   if(sql.startsWith('INSERT INTO public.auth_schema_migrations'))applied=true;
   return [[]];
 }};
 await migration.up({sequelize:db});
 assert.ok(queries.some(sql=>sql.includes('ON CONFLICT ("userId", "structureId", day) DO NOTHING')));
 assert.ok(queries.some(sql=>sql.includes('"calendarEnabled" = true')));
 assert.ok(queries.some(sql=>sql.includes('ON DELETE CASCADE')));
 assert.ok(!queries.some(sql=>/DELETE FROM public.user_availabilities|DROP TABLE|UPDATE public.users /.test(sql)));
 const first=queries.length;await migration.up({sequelize:db});
 assert.equal(queries.slice(first).filter(sql=>sql.startsWith('UPDATE')||sql.startsWith('INSERT')).length,0);
});
it('duplicate legacy weekdays abort before copying or changing operational state',async()=>{
 const queries:string[]=[];const db={transaction:async(fn:any)=>fn({}),query:async(sql:string)=>{
  queries.push(sql);return [sql.includes('HAVING COUNT(*) > 1')?[{userId:'u',day:1}]:[]];
 }};
 await assert.rejects(migration.up({sequelize:db}),/duplicate/);
 assert.equal(queries.filter(sql=>sql.startsWith('UPDATE')||sql.startsWith('INSERT')).length,0);
});

import assert from 'node:assert/strict';
import {it} from 'node:test';
import {migrateTreasuryClassificationTenant} from './treasuryClassificationMigration.js';
import {requiredMigrationNames} from './migrationStatus.js';
import {migrateTreasuryClassification, provisionTenantSchema, reconcileTenantSchemas} from './standardMigrations.js';

it('adds only tenant-local catalogues and classification metadata, preserving the financial ledger',async()=>{
    const statements:string[]=[],transaction={} as any;
    const database={query:async(sql:string,options:any)=>{assert.equal(options.transaction,transaction);statements.push(sql);return [];}} as any;
    await migrateTreasuryClassificationTenant(database,'rehablo_'+'a'.repeat(32),transaction);
    assert.equal(statements.filter(sql=>sql.startsWith('CREATE TABLE')).length,4);
    assert.ok(statements.every(sql=>!/\b(?:UPDATE|DELETE FROM|ALTER TABLE|DROP TABLE|INSERT INTO)\b/.test(sql)));
    assert.ok(statements.some(sql=>sql.includes('PRIMARY KEY ("movementId", "tagId")')));
    assert.ok(statements.some(sql=>sql.includes('"normalizedName" VARCHAR(100) NOT NULL UNIQUE')));
    assert.ok(statements.some(sql=>sql.includes('"treasury_movements"("id") ON DELETE RESTRICT')));
    assert.ok(requiredMigrationNames.includes('202611170001-treasury-classification.js'));
    await assert.rejects(migrateTreasuryClassificationTenant(database,'public',transaction));
});

function fixture(fail = false) {
    const release='202611170001-treasury-classification.js',schema='rehablo_'+'a'.repeat(32),transaction={} as any;
    const names=new Set<string>(requiredMigrationNames.filter(name=>name!==release)),calls:string[]=[];
    const database:any={transaction:async(work:any)=>work(transaction),getQueryInterface:()=>({sequelize:database}),query:async(sql:string,options:any={})=>{
        calls.push(sql);
        if(sql==='SELECT id FROM public.tenants ORDER BY id')return [[{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}]];
        if(sql.includes('SELECT t.id, c.oid IS NOT NULL'))return [[{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',hasMetadata:true}]];
        if(sql.includes('to_regclass'))return [[{registry:schema+'.SequelizeMeta'}]];
        if(sql.startsWith('SELECT name FROM public.'))return [requiredMigrationNames.map(name=>({name}))];
        if(sql.startsWith('SELECT name FROM'))return [[...names].map(name=>({name}))];
        if(!sql.startsWith('SELECT'))assert.equal(options.transaction,transaction);
        if(fail&&sql.includes('CREATE TABLE IF NOT EXISTS')&&sql.includes('treasury_tags'))throw new Error('Cannot create tags');
        if(sql.startsWith('INSERT INTO')&&options.replacements?.name)names.add(options.replacements.name);
        return [[]];
    }};
    return {database,transaction,release,schema,names,calls};
}
it('registers an additive release once without replaying historical migrations or updating money',async()=>{
    const f=fixture();await migrateTreasuryClassification(f.database);
    assert.ok(f.names.has(f.release));assert.ok(f.calls.some(sql=>sql.includes('CREATE TABLE IF NOT EXISTS')&&sql.includes('treasury_categories')));
    assert.ok(f.calls.every(sql=>!sql.includes('schema_migrations')&&!/^(UPDATE|DELETE|ALTER TABLE)/.test(sql)));
    f.calls.length=0;await migrateTreasuryClassification(f.database);
    assert.ok(f.calls.every(sql=>!sql.includes('treasury_categories')));
});
it('does not register a failed release',async()=>{
    const f=fixture(true);await assert.rejects(migrateTreasuryClassification(f.database),/Cannot create tags/);
    assert.equal(f.names.has(f.release),false);
});
it('includes classification in new-tenant provisioning and reconciliation of preceding API tenants',async()=>{
    const f=fixture();await provisionTenantSchema(f.database,f.schema,f.transaction);assert.ok(f.names.has(f.release));
    const previous=fixture();assert.equal(await reconcileTenantSchemas(previous.database),1);assert.ok(previous.names.has(previous.release));
    assert.equal(await reconcileTenantSchemas(previous.database),0);
});

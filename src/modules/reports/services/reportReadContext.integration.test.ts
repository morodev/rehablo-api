import assert from 'node:assert/strict';
import {it} from 'node:test';
import {Sequelize, QueryTypes} from 'sequelize';
import {getReportTransaction, withReportReadSnapshot} from './reportReadContext.js';

const connection = process.env.TEST_FINANCIAL_DATABASE_URL;
it('one financial response has a read-only snapshot and the next request sees a concurrent committed payment', {skip:!connection}, async()=>{
    const url=new URL(connection!);
    assert.ok(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname.endsWith('_test'),'A dedicated local test database is required');
    const database=new Sequelize(connection!,{logging:false,pool:{min:0,max:2}});
    const schema=`performance_reporting_snapshot_${process.pid}_${Date.now()}`;
    const table=`"${schema}".balance`;
    const req={tenantSchema:schema} as any;
    try{
        await database.query(`CREATE SCHEMA "${schema}";CREATE TABLE ${table}(amount numeric(10,2));INSERT INTO ${table} VALUES(20)`);
        const read=async(request:any)=>Number((await database.query<{amount:string}>(`SELECT amount FROM ${table}`,{type:QueryTypes.SELECT,transaction:getReportTransaction(request)}))[0].amount);
        await withReportReadSnapshot(req,async snapshot=>{
            assert.equal(await read(snapshot),20);
            await database.query(`UPDATE ${table} SET amount=100`);
            assert.equal(await read(snapshot),20,'the two phases of one response share a snapshot');
        },database);
        assert.equal(await withReportReadSnapshot(req,read,database),100,'a new request reads the committed state without TTL');
        assert.equal(getReportTransaction(req),undefined,'snapshot is request-local');
        await assert.rejects(withReportReadSnapshot(req,async snapshot=>{
            await database.query(`UPDATE ${table} SET amount=0`,{transaction:getReportTransaction(snapshot)});
        },database),(error:any)=>error.original?.code==='25006');
        assert.equal(await withReportReadSnapshot(req,read,database),100);
    }finally{await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await database.close();}
});

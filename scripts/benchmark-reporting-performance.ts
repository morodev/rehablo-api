/** Local, synthetic benchmark only. Never accepts an application/remote database.
 * TEST_FINANCIAL_DATABASE_URL=postgres://.../rehablo_performance_financial_test
 * node --expose-gc --import tsx scripts/benchmark-reporting-performance.ts
 */
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {Sequelize, QueryTypes} from 'sequelize';
import {readReceivablesPage, type ReceivablesPage} from '../src/modules/reports/services/receivablesLive.service.js';
import {summarizeInvoicePayments} from '../src/modules/invoice/services/payment.service.js';
import {dateOnly} from '../src/modules/reports/services/financialFacts.service.js';

const connection = process.env.TEST_FINANCIAL_DATABASE_URL;
if (!connection) throw new Error('TEST_FINANCIAL_DATABASE_URL is required');
const url = new URL(connection);
if (!['127.0.0.1','localhost'].includes(url.hostname) || !url.pathname.endsWith('_test')) throw new Error('Only an isolated local test database is accepted');
const database = new Sequelize(connection,{logging:false,pool:{min:0,max:2}});
const schema=`performance_reporting_benchmark_${process.pid}_${Date.now()}`;
const prefix=`"${schema}"`;
const site='00000000-0000-4000-8000-000000000001';
const today='2026-11-10';
const query={from:'2026-11-01',to:today,compare:'none' as const,granularity:'day' as const,structureId:null,operatorId:null,eventTypeId:null};
const summary=(values:number[])=>({samplesMs:values.map(value=>+value.toFixed(3)),medianMs:+[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)].toFixed(3)});
type Measurement={value:ReceivablesPage;queries:number;transferredRows:number;transferredBytes:number;milliseconds:number};

async function legacyRead():Promise<Measurement>{
    let queries=0, transferredRows=0, transferredBytes=0;
    const read=async(sql:string,replacements:Record<string,unknown>)=>{
        const rows=await database.query<Record<string,any>>(sql,{type:QueryTypes.SELECT,replacements});
        queries++;transferredRows+=rows.length;transferredBytes+=Buffer.byteLength(JSON.stringify(rows));return rows;
    };
    const start=performance.now();
    const invoices=await read(`SELECT id,"patientID","documentNumber","documentYear","documentType","emissionDate","paymentTerms","invoiceTotal","invoiceNet",status
        FROM ${prefix}.invoices WHERE "structureId"=:site AND status <> 'void' AND "documentType" <> 'nota_di_credito' ORDER BY id`,{site});
    const payments=await read(`SELECT "invoiceId",amount,status,"paidAt",source FROM ${prefix}.invoice_payments WHERE "invoiceId" IN (:ids)`,{ids:invoices.map(row=>row.id)});
    const patients=await read(`SELECT id,name,surname FROM ${prefix}.patients WHERE id IN (:ids)`,{ids:[...new Set(invoices.map(row=>row.patientID).filter(Boolean))]});
    const byInvoice=new Map<string,any[]>();
    for(const payment of payments){const rows=byInvoice.get(payment.invoiceId)??[];rows.push(payment);byInvoice.set(payment.invoiceId,rows);}
    const names=new Map(patients.map(row=>[row.id,[row.name,row.surname].filter(Boolean).join(' ')]));
    const open=invoices.flatMap(invoice=>{
        const paymentSummary=summarizeInvoicePayments(invoice,byInvoice.get(invoice.id)??[]);
        if(paymentSummary.balance<=0)return [];
        const dueDate=invoice.paymentTerms?String(invoice.paymentTerms).slice(0,10):null;
        const dueBucket=!dueDate?'no_due':dueDate<today?'overdue':dueDate===today?'today':dueDate<='2026-11-17'?'next7':'future';
        return [{...invoice,patientName:names.get(invoice.patientID)??'Paziente non disponibile',...paymentSummary,dueDate,dueBucket,
            daysOverdue:dueDate&&dueDate<today?Math.floor((Date.parse(today+'T12:00:00Z')-Date.parse(dueDate+'T12:00:00Z'))/86400000):0}];
    });
    open.sort((a,b)=>(a.dueDate??'9999').localeCompare(b.dueDate??'9999')||String(a.id).localeCompare(String(b.id)));
    const total=(bucket:string)=>open.filter(row=>row.dueBucket===bucket).reduce((sum,row)=>sum+row.balance,0);
    const count=(bucket:string)=>open.filter(row=>row.dueBucket===bucket).length;
    const value:ReceivablesPage={totals:{outstanding:open.reduce((sum,row)=>sum+row.balance,0),overdue:total('overdue'),overdueCount:count('overdue'),
        dueToday:total('today'),dueTodayCount:count('today'),dueNext7:total('next7'),dueNext7Count:count('next7'),noDueDate:total('no_due'),noDueDateCount:count('no_due')},
        pagination:{length:open.length,page:1,size:25,lastPage:Math.max(Math.ceil(open.length/25),1)},invoices:open.slice(0,25)};
    return {value,queries,transferredRows,transferredBytes,milliseconds:performance.now()-start};
}
async function liveRead():Promise<Measurement>{
    const start=performance.now();
    const value=await readReceivablesPage(schema,[site],query,1,25,'all',database,today);
    return {value,queries:1,transferredRows:1,transferredBytes:Buffer.byteLength(JSON.stringify([{result:value}])),milliseconds:performance.now()-start};
}

try{
    await database.query(`CREATE SCHEMA ${prefix};
        CREATE TABLE ${prefix}.invoices (id uuid PRIMARY KEY,"patientID" uuid,"structureId" uuid,"agendaEventId" uuid,"documentNumber" int,"documentYear" int,"documentType" text,"emissionDate" date,"paymentTerms" date,"invoiceTotal" numeric(10,2),"invoiceNet" numeric(10,2),status text);
        CREATE TABLE ${prefix}.invoice_payments(id uuid PRIMARY KEY,"invoiceId" uuid,amount numeric(10,2),status text,source text,"paidAt" date);
        CREATE TABLE ${prefix}.patients(id uuid PRIMARY KEY,name text,surname text);
        CREATE TABLE ${prefix}.agenda_events(id uuid PRIMARY KEY,"invoiceId" uuid,"structureId" uuid,"calendarId" uuid,"eventTypeId" uuid);
        CREATE TABLE ${prefix}.invoice_agenda_events("invoiceId" uuid,"agendaEventId" uuid,"releasedAt" timestamp);
        INSERT INTO ${prefix}.patients SELECT ('00000000-0000-4000-8000-'||LPAD((200000+i)::text,12,'0'))::uuid,'Patient',i::text FROM generate_series(1,500)i;
        INSERT INTO ${prefix}.invoices SELECT ('00000000-0000-4000-8000-'||LPAD((10000+i)::text,12,'0'))::uuid,
            ('00000000-0000-4000-8000-'||LPAD((200001+(i%500))::text,12,'0'))::uuid,
            ('00000000-0000-4000-8000-'||LPAD((CASE WHEN i%5=0 THEN 2 ELSE 1 END)::text,12,'0'))::uuid,
            NULL,i,2025,'fattura','2025-01-01',CASE WHEN i%7=0 THEN NULL ELSE DATE '2026-11-10'+(i%121)-60 END,100,90,'partial' FROM generate_series(1,10000)i;
        INSERT INTO ${prefix}.invoice_payments SELECT ('00000000-0000-4000-8000-'||LPAD((50000+(i-1)*4+j)::text,12,'0'))::uuid,
            ('00000000-0000-4000-8000-'||LPAD((10000+i)::text,12,'0'))::uuid,10,'POSTED','USER','2025-02-01'
            FROM generate_series(1,10000)i CROSS JOIN generate_series(1,4)j;
        CREATE INDEX ON ${prefix}.invoices("structureId","emissionDate");
        CREATE INDEX ON ${prefix}.invoice_payments("invoiceId",status);
        ANALYZE ${prefix}.invoices; ANALYZE ${prefix}.invoice_payments; ANALYZE ${prefix}.patients;`);
    const warmLegacy=await legacyRead(),warmLive=await liveRead();assert.deepEqual(warmLive.value,warmLegacy.value);
    const legacy:number[]=[],live:number[]=[];
    for(let n=0;n<7;n++){
        const ordered=n%2?[liveRead,legacyRead]:[legacyRead,liveRead];
        for(const run of ordered){const sample=await run();assert.deepEqual(sample.value,warmLegacy.value);(run===legacyRead?legacy:live).push(sample.milliseconds);}
    }
    const dates=Array.from({length:10000},(_,n)=>new Date(Date.UTC(2026,n%12,(n%28)+1,23,30)).toISOString());
    const formatterOld=(value:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
    assert.deepEqual(dates.slice(0,100).map(dateOnly),dates.slice(0,100).map(formatterOld));
    const oldDates:number[]=[],newDates:number[]=[];
    let checksum=0;
    for(let n=0;n<3;n++){
        global.gc?.();let start=performance.now();for(const date of dates)checksum+=formatterOld(date).length;oldDates.push(performance.now()-start);
        global.gc?.();start=performance.now();for(const date of dates)checksum+=dateOnly(date).length;newDates.push(performance.now()-start);
    }
    const report={generatedAt:new Date().toISOString(),environment:{node:process.version,platform:process.platform,postgres:'16 (local Docker)',dataset:'synthetic, no application data'},
        limitations:['Local benchmark; not a production/Render SLO measurement.','Legacy extraction uses raw query rows and the existing payment classifier, omitting Sequelize model construction overhead.',
            'Transferred bytes are JSON-serialized result sizes, not wire-level network traffic.','Live returns one aggregate result row containing the 25 visible invoices.','Database plans and caches were warmed once; seven alternating measured reads.'],
        receivables:{invoices:10000,payments:40000,selectedInvoices:8000,pageSize:25,parity:'deepEqual on complete public result for every measured read',
            legacy:{...summary(legacy),queries:warmLegacy.queries,transferredRows:warmLegacy.transferredRows,serializedResultBytes:warmLegacy.transferredBytes},
            live:{...summary(live),queries:warmLive.queries,transferredRows:warmLive.transferredRows,serializedResultBytes:warmLive.transferredBytes}},
        dateFormatting:{timestampCount:dates.length,checksum,oldFormatter:summary(oldDates),sharedFormatter:summary(newDates)}};
    process.stdout.write(JSON.stringify(report,null,2)+'\n');
}finally{await database.query(`DROP SCHEMA IF EXISTS ${prefix} CASCADE`);await database.close();}

import assert from 'node:assert/strict';
import {it} from 'node:test';
import {Sequelize, QueryTypes} from 'sequelize';
import {readReceivablesPage} from './receivablesLive.service.js';
import {summarizeInvoicePayments} from '../../invoice/services/payment.service.js';
import type {AnalyticsQuery} from './analytics.service.js';

const connection = process.env.TEST_FINANCIAL_DATABASE_URL;
const query: AnalyticsQuery = {from: '2026-11-01', to: '2026-11-10', compare: 'none', granularity: 'day',
    structureId: null, operatorId: null, eventTypeId: null};
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

it('live SQL receivables preserve reference balances, cumulative attribution, scopes and paging', {skip: !connection}, async () => {
    const url = new URL(connection!);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname.endsWith('_test'), 'An isolated local test database is required');
    const database = new Sequelize(connection!, {logging: false});
    const schema = `performance_reporting_${process.pid}_${Date.now()}`;
    const prefix = `"${schema}"`;
    const today = '2026-11-10', site = uuid(1), otherSite = uuid(2), operator = uuid(3), otherOperator = uuid(4), type = uuid(5);
    const patient = uuid(6);
    try {
        await database.query(`CREATE SCHEMA ${prefix}`);
        await database.query(`CREATE TABLE ${prefix}.invoices (id uuid PRIMARY KEY, "patientID" uuid, "structureId" uuid,
            "agendaEventId" uuid, "documentNumber" integer, "documentYear" integer, "documentType" text, "emissionDate" date,
            "paymentTerms" date, "invoiceTotal" numeric(10,2), "invoiceNet" numeric(10,2), status text);
            CREATE TABLE ${prefix}.invoice_payments (id uuid PRIMARY KEY, "invoiceId" uuid, amount numeric(10,2), status text, source text, "paidAt" date);
            CREATE TABLE ${prefix}.patients (id uuid PRIMARY KEY, name text, surname text);
            CREATE TABLE ${prefix}.agenda_events (id uuid PRIMARY KEY, "invoiceId" uuid, "structureId" uuid, "calendarId" uuid, "eventTypeId" uuid);
            CREATE TABLE ${prefix}.invoice_agenda_events ("invoiceId" uuid, "agendaEventId" uuid, "releasedAt" timestamp);`);
        await database.query(`INSERT INTO ${prefix}.patients VALUES (:id, 'Mario', 'Rossi')`, {replacements: {id: patient}});
        const bills = Array.from({length: 231}, (_, n) => ({id: uuid(100+n), patientID: n === 0 ? null : patient,
            structureId: n === 230 ? otherSite : site, agendaEventId: n < 2 ? uuid(500+n) : null,
            documentNumber: n+1, documentYear: 2025, documentType: n === 9 ? 'nota_di_credito' : 'fattura',
            emissionDate: n === 8 ? null : '2025-01-01', paymentTerms: ['2026-11-01', today, '2026-11-13', null, '2026-12-01'][n % 5],
            invoiceTotal: '100.00', invoiceNet: n === 7 ? null : '90.00', status: n === 2 || n === 3 ? 'paid' : n === 4 ? 'void' : n === 5 ? 'draft' : n === 6 ? 'cancelled' : 'unpaid'}));
        for (const invoice of bills) await database.query(`INSERT INTO ${prefix}.invoices VALUES
            (:id,:patientID,:structureId,:agendaEventId,:documentNumber,:documentYear,:documentType,:emissionDate,:paymentTerms,:invoiceTotal,:invoiceNet,:status)`, {replacements: invoice});
        const payments = [
            {id: uuid(800), invoiceId: bills[0].id, amount: '30.00', status: 'POSTED', source: 'USER', paidAt: '2025-01-01'},
            {id: uuid(801), invoiceId: bills[0].id, amount: '10.00', status: 'VOID', source: 'USER', paidAt: '2026-11-01'},
            {id: uuid(802), invoiceId: bills[1].id, amount: '20.00', status: 'POSTED', source: 'LEGACY_IMPORT', paidAt: null},
            {id: uuid(803), invoiceId: bills[3].id, amount: '90.00', status: 'VOID', source: 'USER', paidAt: null},
            {id: uuid(804), invoiceId: bills[10].id, amount: '100.00', status: 'POSTED', source: 'CREDIT', paidAt: null}
        ];
        for (const payment of payments) await database.query(`INSERT INTO ${prefix}.invoice_payments VALUES (:id,:invoiceId,:amount,:status,:source,:paidAt)`, {replacements: payment});
        await database.query(`INSERT INTO ${prefix}.agenda_events VALUES
            (:first, :bill, :site, :operator, :type), (:hidden, :bill, :otherSite, :operator, :type),
            (:second, :secondBill, :site, :operator, :type), (:mixed, :secondBill, :site, :otherOperator, :type);
            INSERT INTO ${prefix}.invoice_agenda_events VALUES (:bill,:first,NULL),(:bill,:hidden,now()),(:secondBill,:second,NULL),(:secondBill,:mixed,NULL)`,
            {replacements: {first: uuid(500), hidden: uuid(510), second: uuid(501), mixed: uuid(511), bill: bills[0].id,
                secondBill: bills[1].id, site, otherSite, operator, otherOperator, type}});
        const reference = bills.filter(row => row.structureId === site && row.emissionDate && row.documentType !== 'nota_di_credito'
            && !['void','draft','cancelled'].includes(row.status)).map(invoice => {
            const summary = summarizeInvoicePayments(invoice, payments.filter(row => row.invoiceId === invoice.id));
            const dueDate = invoice.paymentTerms;
            const dueBucket = !dueDate ? 'no_due' : dueDate < today ? 'overdue' : dueDate === today ? 'today' : dueDate <= '2026-11-17' ? 'next7' : 'future';
            const {structureId: _site, agendaEventId: _event, ...fields} = invoice;
            return {...fields, patientName: invoice.patientID ? 'Mario Rossi' : 'Paziente non disponibile', ...summary,
                dueDate, dueBucket, daysOverdue: dueDate && dueDate < today ? (Date.parse(today)-Date.parse(dueDate))/86400000 : 0};
        }).filter(row => row.balance > 0).sort((a,b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.id.localeCompare(b.id));
        const expectedTotals = {outstanding: reference.reduce((sum,row)=>sum+row.balance,0), overdue: 0, overdueCount: 0,
            dueToday: 0, dueTodayCount: 0, dueNext7: 0, dueNext7Count: 0, noDueDate: 0, noDueDateCount: 0};
        for (const [bucket, field] of [['overdue','overdue'],['today','dueToday'],['next7','dueNext7'],['no_due','noDueDate']]) {
            const rows = reference.filter(row=>row.dueBucket===bucket);
            (expectedTotals as any)[field] = rows.reduce((sum,row)=>sum+row.balance,0);
            (expectedTotals as any)[field+'Count'] = rows.length;
        }
        for (const bucket of ['all','overdue','today','next7','no_due']) {
            const selected = bucket === 'all' ? reference : reference.filter(row=>row.dueBucket === bucket);
            for (const page of [1,2,20]) {
                const actual = await readReceivablesPage(schema,[site],query,page,25,bucket,database,today);
                assert.deepEqual(actual.totals, expectedTotals);
                assert.deepEqual(actual.invoices, selected.slice((page-1)*25,page*25));
                assert.equal(actual.pagination.length, selected.length);
                assert.equal(actual.pagination.lastPage, Math.max(Math.ceil(selected.length/25),1));
            }
        }
        assert.equal((await readReceivablesPage(schema,[site],{...query,operatorId:operator},1,25,'all',database,today)).pagination.length,0,
            'hidden-site and mixed-operator children prevent whole-document attribution, even released links');
        const typesOnly = await readReceivablesPage(schema,[site],{...query,eventTypeId:type},1,25,'all',database,today);
        assert.deepEqual(typesOnly.invoices.map(row=>row.id),[bills[1].id]);
        assert.equal((await readReceivablesPage(schema,[site],{...query,eventTypeId:type,eventTypeIds:[uuid(999)]},1,25,'all',database,today)).pagination.length,0);
        assert.equal((await readReceivablesPage(schema,[site],{...query,eventTypeId:type,patientId:uuid(999)},1,25,'all',database,today)).pagination.length,0);
        assert.deepEqual((await readReceivablesPage(schema,[site],{...query,eventTypeId:type,patientId:patient,eventTypeIds:[type]},1,25,'all',database,today)).invoices,typesOnly.invoices);
        await assert.rejects(readReceivablesPage(schema,[site],{...query,eventTypeId:type,patientId:'invalid'},1,25,'all',database,today),/Paziente non valido/);
        const allSites = await readReceivablesPage(schema,[site,otherSite],{...query,operatorId:operator},1,25,'all',database,today);
        assert.deepEqual(allSites.invoices.map(row=>row.id),[bills[0].id]);
        await database.query(`UPDATE ${prefix}.invoice_payments SET amount=90 WHERE id=:id`, {replacements:{id:payments[0].id}});
        const refreshed = await readReceivablesPage(schema,[site],query,1,25,'all',database,today);
        assert.equal(refreshed.totals.outstanding,expectedTotals.outstanding-60,'committed payment is visible immediately');
        assert.equal((await readReceivablesPage(schema,[],query,1,25,'all',database,today)).pagination.length,0);
        await assert.rejects(readReceivablesPage('bad"schema',[site],query,1,25,'all',database,today),/Invalid tenant schema/);
    } finally {
        await database.query(`DROP SCHEMA IF EXISTS ${prefix} CASCADE`);
        await database.close();
    }
});

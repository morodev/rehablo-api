import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after, before, test} from 'node:test';

// Verify isolation before any application module initializes its database connection.
const {requireActivitiesTestDatabase} = await import('../../../../scripts/activities-test-database.mjs');
const target = requireActivitiesTestDatabase(process.env);
process.env.DATABASE_URL = target.databaseUrl;
process.env.DB_SSL = 'false';
process.env.NODE_ENV = 'test';
const {sequelize} = await import('../../../config/database.js');
(sequelize as any).options.logging = false;
const {Tenant} = await import('../../auth/models/index.js');
const {default: AgendaEvent} = await import('../models/agendaEvent.model.js');
const {default: Invoice} = await import('../../invoice/models/invoice.model.js');
const {default: InvoicePayment} = await import('../../invoice/models/invoicePayment.model.js');
const {default: InvoiceAgendaEvent} = await import('../../invoice/models/invoiceAgendaEvent.model.js');
const {CarePackage, FinancialAccount} = await import('../../administration/models/index.js');
const {updateAppointmentPricing, listAppointmentPayments, createAppointmentPayment} = await import('../controllers/appointmentPayment.controller.js');
const {patientSettlementPositionView} = await import('../../patients/services/patientSettlementAccess.service.js');

const schema = 'rehablo_' + randomUUID().replaceAll('-', '');
const structureId = randomUUID(), userId = randomUUID();
let created = false;
before(async () => {
    await sequelize.authenticate();
    const [rows] = await sequelize.query('SELECT current_database() AS name');
    assert.equal((rows[0] as any).name, target.databaseName);
    await Tenant.sync({force: false, alter: false});
    assert.match(schema, /^rehablo_[a-f0-9]{32}$/);
    await sequelize.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    for (const model of [AgendaEvent, Invoice, InvoicePayment, InvoiceAgendaEvent, CarePackage, FinancialAccount]) {
        await (model as any).schema(schema).sync({force: false, alter: false});
    }
});
after(async () => {
    try {if (created) await sequelize.query(`DROP SCHEMA "${schema}" CASCADE`);} finally {await sequelize.close();}
});

async function event(extra: Record<string, any> = {}) {
    return AgendaEvent.schema(schema).create({patientId: randomUUID(), structureId, title: 'Seduta senza prezzo',
        start: '2025-01-05T10:00:00Z', end: '2025-01-05T11:00:00Z', status: 'CONFIRMED',
        appointmentExpectedAmount: null, appointmentOriginalAmount: null, appointmentPaymentHistoryKnown: false, ...extra});
}
function request(record: any, body: Record<string, unknown> = {}): any {
    return {tenantSchema: schema, params: {agendaEventId: record.id}, body,
        user: {sub: userId, isSuperAdmin: true}, access: {scope: 'tenant', structureId, userId}};
}
function run(handler: any, req: any): Promise<{status: number; data: any; message: string}> {
    return new Promise((resolve, reject) => {
        const res: any = {statusCode: 200, status(status: number) {this.statusCode = status; return this;},
            json(body: any) {resolve({status: this.statusCode, data: body.data, message: body.message}); return this;}};
        handler(req, res, (error: any) => error?.statusCode
            ? resolve({status: error.statusCode, data: null, message: error.message}) : reject(error));
    });
}
async function position(record: any) {
    return patientSettlementPositionView(request(record), {patientId: record.patientId, structureId,
        referenceAgendaEventId: record.id, patient: {id: record.patientId}} as any, {administrationEnabled: false});
}

test('defines a price, keeps historical collection blocked, then verifies and collects without changing presence', async () => {
    const record = await event();
    let response = await run(updateAppointmentPricing, request(record, {adjustment: null, baseAmount: 65.5, markCompleted: true}));
    assert.equal(response.status, 200, response.message);
    assert.equal(response.data.summary.expectedAmount, 65.5);
    assert.equal(response.data.summary.paidAmount, 0);
    await record.reload();
    assert.equal(record.appointmentPaymentHistoryKnown, false);
    assert.equal(record.status, 'CONFIRMED');
    assert.equal(await InvoicePayment.schema(schema).count({where: {agendaEventId: record.id}}), 0);
    const unverified = await position(record);
    assert.equal(unverified.reference.pricing?.historyKnown, false);
    assert.equal(unverified.reference.currentEligible, false);
    assert.ok(unverified.verification.some(row => row.agendaEventId === record.id));
    response = await run(createAppointmentPayment, request(record, {amount: 65.5, paidAt: '2025-01-05'}));
    assert.equal(response.status, 409);
    response = await run(updateAppointmentPricing, request(record, {adjustment: null, confirmHistory: true}));
    assert.equal(response.status, 200, response.message);
    await record.reload();
    assert.equal(record.appointmentPaymentHistoryKnown, true);
    assert.equal(record.status, 'CONFIRMED');
    assert.equal(await InvoicePayment.schema(schema).count({where: {agendaEventId: record.id}}), 0);
    assert.equal((await position(record)).reference.currentEligible, true);
    const history = await run(listAppointmentPayments, request(record));
    assert.equal(history.data.pricing.historyKnown, true);
    assert.equal(history.data.summary.balance, 65.5);
    response = await run(createAppointmentPayment, request(record, {amount: 65.5, paidAt: '2025-01-05'}));
    assert.equal(response.status, 201, response.message);
    assert.equal(response.data.summary.balance, 0);
    assert.equal(response.data.summary.paymentStatus, 'paid');
});

test('invalid concessions roll back price snapshots and verification in PostgreSQL', async () => {
    const record = await event();
    const response = await run(updateAppointmentPricing, request(record, {baseAmount: 50, adjustment: 'DISCOUNT', discountAmount: 60, confirmHistory: true}));
    assert.equal(response.status, 400);
    await record.reload();
    assert.equal(record.appointmentExpectedAmount, null);
    assert.equal(record.appointmentOriginalAmount, null);
    assert.equal(record.appointmentPaymentHistoryKnown, false);
});

test('concurrent definitions serialize on the locked event and never overwrite the winning agreement', async () => {
    const record = await event();
    const responses = await Promise.all([40, 70].map(baseAmount => run(updateAppointmentPricing, request(record, {adjustment: null, baseAmount}))));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    await record.reload();
    assert.equal(Number(record.appointmentExpectedAmount), responses.find(response => response.status === 200)!.data.summary.expectedAmount);
    assert.equal(record.appointmentPaymentHistoryKnown, false);
});

test('recorded receipts survive price definition and prevent a lower agreement or gift', async () => {
    const record = await event();
    const receipt = await InvoicePayment.schema(schema).create({agendaEventId: record.id, amount: 20, status: 'POSTED',
        source: 'APPOINTMENT', paidAt: new Date('2025-01-05T12:00:00Z'), method: 'Contanti'}, {hooks: false});
    assert.equal((await run(updateAppointmentPricing, request(record, {adjustment: null, baseAmount: 10}))).status, 400);
    assert.equal((await run(updateAppointmentPricing, request(record, {adjustment: 'COMPLIMENTARY'}))).status, 400);
    const response = await run(updateAppointmentPricing, request(record, {adjustment: null, baseAmount: 50}));
    assert.equal(response.status, 200, response.message);
    assert.equal(response.data.summary.paidAmount, 20);
    assert.equal(response.data.summary.balance, 30);
    await receipt.reload();
    assert.equal(Number(receipt.amount), 20);
    assert.equal(receipt.method, 'Contanti');
    assert.equal(await InvoicePayment.schema(schema).count({where: {agendaEventId: record.id}}), 1);
});

test('pricing guards reject unauthorized, invoiced, packaged and recurring sessions', async () => {
    const record = await event();
    const req = request(record, {adjustment: null, baseAmount: 50});
    req.user = {sub: userId, perms: []};
    assert.equal((await run(updateAppointmentPricing, req)).status, 403);
    for (const extra of [{invoiceId: randomUUID()}, {carePackageId: randomUUID(), packageReservationStatus: 'RESERVED'}, {recurringEventId: randomUUID()}]) {
        const blocked = await event(extra);
        const response = await run(updateAppointmentPricing, request(blocked, {adjustment: null, baseAmount: 50}));
        assert.ok([409, 422].includes(response.status), response.message);
        await blocked.reload();
        assert.equal(blocked.appointmentExpectedAmount, null);
    }
});

test('a gift without history confirmation does not clear the verification flag or create cash', async () => {
    const record = await event();
    const response = await run(updateAppointmentPricing, request(record, {adjustment: 'COMPLIMENTARY'}));
    assert.equal(response.status, 200, response.message);
    await record.reload();
    assert.equal(record.appointmentPaymentHistoryKnown, false);
    assert.equal(record.appointmentPriceAdjustment, 'COMPLIMENTARY');
    assert.equal(await InvoicePayment.schema(schema).count({where: {agendaEventId: record.id}}), 0);
});

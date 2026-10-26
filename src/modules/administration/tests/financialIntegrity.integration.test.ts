import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after, before, test, TestContext} from 'node:test';

// An explicit, local, disposable database is checked before application configuration loads.
const {requireFinancialTestDatabase} = await import('../../../../scripts/financial-test-database.mjs');
const target = requireFinancialTestDatabase(process.env);
process.env.DATABASE_URL = target.databaseUrl;
process.env.DB_SSL = 'false';
process.env.NODE_ENV = 'test';
process.env.TENANT_SCHEMA_SYNC = 'additive';
const {sequelize} = await import('../../../config/database.js');
(sequelize as any).options.logging = false;
const {Tenant} = await import('../../auth/models/index.js');
const {default: AgendaEvent} = await import('../../agenda/models/agendaEvent.model.js');
const {default: Invoice} = await import('../../invoice/models/invoice.model.js');
const {default: InvoicePayment} = await import('../../invoice/models/invoicePayment.model.js');
const {default: InvoiceAgendaEvent} = await import('../../invoice/models/invoiceAgendaEvent.model.js');
const {CarePackage, FinancialAccount, PaymentMethod, TreasuryMovement} = await import('../models/index.js');
const {FinancialOperation} = await import('../models/financialOperation.model.js');
const {createAppointmentPayment} = await import('../../agenda/controllers/appointmentPayment.controller.js');
const {readFinancialOptions} = await import('../services/financialAccountResolver.service.js');
const {linkAppointmentPayments} = await import('../../invoice/services/appointmentPayment.service.js');
const {syncInvoicePaymentStatus} = await import('../../invoice/services/payment.service.js');
const {balanceEffectiveMovements, treasuryBalance} = await import('../services/treasuryLedger.service.js');
const models = [AgendaEvent, Invoice, InvoicePayment, InvoiceAgendaEvent, CarePackage, FinancialAccount,
    PaymentMethod, TreasuryMovement, FinancialOperation];

before(async () => {
    await sequelize.authenticate();
    const [rows] = await sequelize.query('SELECT current_database() AS name');
    assert.equal((rows[0] as any).name, target.databaseName);
    await Tenant.sync({force: false, alter: false});
});
after(async () => {await sequelize.close();});

async function fixture(t: TestContext) {
    const tenantId = randomUUID(), structureId = randomUUID(), userId = randomUUID();
    const schema = 'rehablo_' + tenantId.replaceAll('-', '');
    assert.match(schema, /^rehablo_[a-f0-9]{32}$/);
    let schemaCreated = false;
    t.after(async () => {
        try {
            assert.match(schema, /^rehablo_[a-f0-9]{32}$/);
            if (schemaCreated) await sequelize.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {await Tenant.destroy({where: {id: tenantId}});}
    });
    await Tenant.create({id: tenantId, license: 'synthetic-financial-integration', idStripe: 'synthetic',
        maxUserQuantity: 1, maxStructureQuantity: 1, administrationSettings: {}});
    await sequelize.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    for (const model of models) await (model as any).schema(schema).sync({force: false, alter: false});
    const event = (amount = 40) => AgendaEvent.schema(schema).create({patientId: randomUUID(), structureId,
        title: 'Synthetic financial integration', start: '2025-01-05T10:00:00Z', end: '2025-01-05T11:00:00Z',
        status: 'CONFIRMED', appointmentExpectedAmount: amount, appointmentOriginalAmount: amount,
        appointmentPaymentHistoryKnown: true});
    const request = (record: any, body: Record<string, unknown>, key: string = randomUUID()): any => ({
        tenantSchema: schema, params: {agendaEventId: record.id}, body,
        header: (name: string) => name.toLowerCase() === 'idempotency-key' ? key : undefined,
        user: {sub: userId, tenantId, isSuperAdmin: true}, access: {scope: 'tenant', tenantId, structureId, userId}
    });
    const cash = (record: any, extra: Record<string, unknown> = {}, key?: string) =>
        run(createAppointmentPayment, request(record, {amount: Number(record.appointmentExpectedAmount), paidAt: '2025-01-05', ...extra}, key));
    const balance = async (accountId: string) => {
        const account = await FinancialAccount.schema(schema).findByPk(accountId);
        const rows = await TreasuryMovement.schema(schema).findAll({where: {accountId}});
        return treasuryBalance(balanceEffectiveMovements(rows.map(row => row.get({plain: true}))), Number(account!.get('openingBalance')));
    };
    return {tenantId, schema, structureId, userId, event, request, cash, balance};
}

function run(handler: any, req: any): Promise<{status: number; data: any; message: string}> {
    return new Promise((resolve, reject) => {
        const res: any = {statusCode: 200, status(status: number) {this.statusCode = status; return this;},
            json(body: any) {resolve({status: this.statusCode, data: body.data, message: body.message}); return this;}};
        try {
            const pending = handler(req, res, (error: any) => error
                ? resolve({status: error.statusCode ?? error.status ?? 500, data: null, message: error.message})
                : reject(new Error('Handler completed without a response')));
            pending?.catch(reject);
        } catch (error) {reject(error);}
    });
}

test('PostgreSQL serializes simultaneous first receipts into one zero-opening cash account', async t => {
    const f = await fixture(t);
    const empty = await readFinancialOptions(f.schema, f.structureId);
    assert.equal(empty.willCreateDefaultAccount, true);
    assert.equal(await FinancialAccount.schema(f.schema).count(), 0, 'reading options cannot create an account');
    const events = await Promise.all([f.event(40), f.event(60)]);
    const responses = await Promise.all(events.map(record => f.cash(record)));
    for (const response of responses) assert.equal(response.status, 201, response.message);
    const accounts = await FinancialAccount.schema(f.schema).findAll();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].get('name'), 'Cassa principale');
    assert.equal(Number(accounts[0].get('openingBalance')), 0);
    assert.equal(accounts[0].get('structureId'), f.structureId);
    assert.equal(await InvoicePayment.schema(f.schema).count(), 2);
    assert.equal(await TreasuryMovement.schema(f.schema).count({where: {accountId: accounts[0].get('id')}}), 2);
    assert.equal(await FinancialOperation.schema(f.schema).count(), 2);
    assert.equal(await f.balance(String(accounts[0].get('id'))), 100);
});

test('PostgreSQL uses a sole account, a site favourite, and requires an explicit choice otherwise', async t => {
    const f = await fixture(t);
    const first = await FinancialAccount.schema(f.schema).create({structureId: f.structureId, name: 'First', type: 'BANK', openingBalance: 10});
    assert.equal((await f.cash(await f.event(20))).status, 201);
    assert.equal(await f.balance(String(first.get('id'))), 30);
    const second = await FinancialAccount.schema(f.schema).create({structureId: f.structureId, name: 'Second', type: 'BANK'});
    const ambiguous = await f.event(30);
    const blocked = await f.cash(ambiguous);
    assert.equal(blocked.status, 422, blocked.message);
    assert.equal(await InvoicePayment.schema(f.schema).count({where: {agendaEventId: ambiguous.id}}), 0);
    await Tenant.update({administrationSettings: {treasury: {defaultAccountByStructureId: {[f.structureId]: second.get('id')}}}}, {where: {id: f.tenantId}});
    assert.equal((await f.cash(ambiguous)).status, 201);
    assert.equal(await f.balance(String(second.get('id'))), 30);
    assert.equal((await f.cash(await f.event(15), {accountId: first.get('id')})).status, 201);
    assert.equal(await f.balance(String(first.get('id'))), 45, 'an explicit valid choice overrides the favourite');
});

test('PostgreSQL rolls back cash account, receipt, ledger and operation together on a ledger failure', async t => {
    const f = await fixture(t), record = await f.event(40), key = randomUUID();
    await sequelize.query(`CREATE FUNCTION "${f.schema}".reject_test_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic ledger failure'; END $$`);
    await sequelize.query(`CREATE TRIGGER reject_test_ledger BEFORE INSERT ON "${f.schema}"."treasury_movements" FOR EACH ROW EXECUTE FUNCTION "${f.schema}".reject_test_ledger()`);
    const response = await f.cash(record, {}, key);
    assert.equal(response.status, 500, response.message);
    for (const model of [FinancialAccount, InvoicePayment, TreasuryMovement, FinancialOperation]) {
        assert.equal(await model.schema(f.schema).count(), 0, `${model.name} must roll back`);
    }
    await record.reload();
    assert.equal(Number(record.appointmentPaidAmount), 0);
    await sequelize.query(`DROP TRIGGER reject_test_ledger ON "${f.schema}"."treasury_movements"`);
    assert.equal((await f.cash(record, {}, key)).status, 201, 'the failed operation key remains retryable');
});

test('PostgreSQL returns the same receipt for concurrent retries and rejects different payloads with 409', async t => {
    const f = await fixture(t), record = await f.event(40), key = randomUUID();
    const responses = await Promise.all([f.cash(record, {}, key), f.cash(record, {}, key)]);
    for (const response of responses) assert.equal(response.status, 201, response.message);
    assert.equal(responses[0].data.payment.id, responses[1].data.payment.id);
    assert.equal(await InvoicePayment.schema(f.schema).count(), 1);
    assert.equal(await TreasuryMovement.schema(f.schema).count(), 1);
    assert.equal(await FinancialOperation.schema(f.schema).count(), 1);
    const mismatch = await f.cash(record, {amount: 39}, key);
    assert.equal(mismatch.status, 409, mismatch.message);
    assert.equal(await InvoicePayment.schema(f.schema).count(), 1);
});

test('agenda receipt updates the cash balance and attaches to a later invoice without another cash entry', async t => {
    const f = await fixture(t), record = await f.event(65.5);
    const response = await f.cash(record);
    assert.equal(response.status, 201, response.message);
    const original = await TreasuryMovement.schema(f.schema).findOne();
    assert.equal(await f.balance(String(original!.get('accountId'))), 65.5);
    const invoice = await sequelize.transaction(async transaction => {
        const invoice = await Invoice.schema(f.schema).create({patientID: record.patientId, structureId: f.structureId,
            agendaEventId: record.id, invoiceTotal: 65.5, invoiceNet: 65.5, status: 'unpaid'}, {transaction});
        await InvoiceAgendaEvent.schema(f.schema).create({invoiceId: invoice.id, agendaEventId: record.id}, {transaction});
        // The exact production service used when emitting an invoice preserves the existing payment IDs.
        await linkAppointmentPayments(f.schema, [record.id], invoice.id, transaction);
        const summary = await syncInvoicePaymentStatus(f.schema, invoice.id, transaction);
        assert.equal(summary.paidAmount, 65.5);
        assert.equal(summary.balance, 0);
        return invoice;
    });
    await invoice.reload();
    assert.equal(invoice.status, 'paid');
    const payment = await InvoicePayment.schema(f.schema).findByPk(response.data.payment.id);
    assert.equal(payment!.invoiceId, invoice.id);
    assert.equal(payment!.source, 'APPOINTMENT');
    assert.equal(await InvoicePayment.schema(f.schema).count(), 1);
    assert.equal(await TreasuryMovement.schema(f.schema).count(), 1);
    assert.equal(await f.balance(String(original!.get('accountId'))), 65.5);
});

test('historical balances, credit and package coverage do not create cash accounts or ledger entries', async t => {
    const f = await fixture(t), record = await f.event(100);
    await sequelize.transaction(async transaction => {
        for (const source of ['OPENING_BALANCE', 'LEGACY_IMPORT', 'CREDIT', 'PACKAGE'] as const) {
            await InvoicePayment.schema(f.schema).create({agendaEventId: record.id, amount: 25,
                source, status: 'POSTED', paidAt: source === 'OPENING_BALANCE' ? null : new Date('2025-01-05T12:00:00Z')}, {transaction});
        }
    });
    assert.equal(await InvoicePayment.schema(f.schema).count(), 4);
    assert.equal(await FinancialAccount.schema(f.schema).count(), 0);
    assert.equal(await TreasuryMovement.schema(f.schema).count(), 0);
});

test('additive tenant bootstrap and a second run preserve historical data and install the financial registry once', async t => {
    const f = await fixture(t);
    const {requiredTenantSchemaVersions, FINANCIAL_INTEGRITY_VERSION, TENANT_MODEL_BASELINE_VERSION, isTenantSchemaCurrent} =
        await import('../../../utils/tenantMigrations.js');
    const {registerTenantScopedModel, ensureTenantSchema, invalidateTenantSchemaCache} = await import('../../../utils/tenantSchema.js');
    // Existing tenant: unrelated migrations are already recorded, financial operations are absent.
    await FinancialOperation.schema(f.schema).drop();
    const account = await FinancialAccount.schema(f.schema).create({structureId: f.structureId, name: 'Historic cash', openingBalance: 7});
    const record = await f.event(23);
    const previous = await InvoicePayment.schema(f.schema).create({agendaEventId: record.id, amount: 23,
        source: 'LEGACY_IMPORT', status: 'POSTED', paidAt: null}, {hooks: false});
    await sequelize.query(`ALTER TABLE "${f.schema}"."financial_accounts" ADD COLUMN "legacyMemo" TEXT DEFAULT 'preserve me'`);
    await sequelize.query(`ALTER TABLE "${f.schema}"."financial_accounts" DROP COLUMN "metadata"`);
    await sequelize.query(`CREATE TABLE "${f.schema}"."schema_migrations" ("version" VARCHAR(160) PRIMARY KEY, "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    for (const version of requiredTenantSchemaVersions().filter(value => ![FINANCIAL_INTEGRITY_VERSION, TENANT_MODEL_BASELINE_VERSION].includes(value))) {
        await sequelize.query(`INSERT INTO "${f.schema}"."schema_migrations" ("version") VALUES (:version)`, {replacements: {version}});
    }
    for (const model of models) registerTenantScopedModel(model as any);
    assert.equal(await isTenantSchemaCurrent(f.schema), false);
    assert.equal(await ensureTenantSchema(f.tenantId), f.schema);
    invalidateTenantSchemaCache(f.tenantId);
    assert.equal(await ensureTenantSchema(f.tenantId), f.schema);
    assert.equal(await isTenantSchemaCurrent(f.schema), true);
    const [columns] = await sequelize.query(`SELECT "legacyMemo", "metadata", "openingBalance" FROM "${f.schema}"."financial_accounts" WHERE "id"=:id`, {replacements: {id: account.get('id')}});
    assert.equal((columns[0] as any).legacyMemo, 'preserve me');
    assert.deepEqual((columns[0] as any).metadata, {});
    assert.equal(Number((columns[0] as any).openingBalance), 7);
    await previous.reload();
    assert.equal(previous.paidAt, null);
    assert.equal(previous.source, 'LEGACY_IMPORT');
    assert.equal(Number(previous.amount), 23);
    assert.equal(await TreasuryMovement.schema(f.schema).count(), 0, 'bootstrap must not invent historical cash');
    assert.equal(await FinancialOperation.schema(f.schema).count(), 0);
    const [versions] = await sequelize.query(`SELECT "version" FROM "${f.schema}"."schema_migrations" WHERE "version"=:version`, {replacements: {version: FINANCIAL_INTEGRITY_VERSION}});
    assert.equal(versions.length, 1);
    invalidateTenantSchemaCache(f.tenantId);
});

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {after, before, test, TestContext} from 'node:test';
const {requireFinancialTestDatabase} = await import('../../../../scripts/financial-test-database.mjs');
// Reuse the explicit local disposable-database guard; never consult the application URL.
const target = requireFinancialTestDatabase(process.env);
process.env.DATABASE_URL = target.databaseUrl; process.env.DB_SSL = 'false'; process.env.NODE_ENV = 'test';
const {sequelize} = await import('../../../config/database.js');
(sequelize as any).options.logging = false;
const {Tenant, User, Structure, TenantUser, StructureUser} = await import('../../auth/models/index.js');
const {RoleCode} = await import('../../auth/rbac/roles.js');
const {default: Patient} = await import('../models/patient.model.js');
const {PatientContactFollowUp} = await import('../models/patientContactFollowUp.model.js');
const {default: Reminder} = await import('../../notes/models/reminder.model.js');
const {default: ReminderAssignment} = await import('../../notes/models/reminderAssignment.model.js');
const {default: ReminderAlertState} = await import('../../notes/models/reminderAlertState.model.js');
const {setPatientContactFollowUp} = await import('./patientContactFollowUp.service.js');
const {claimReminderAlerts, snoozeReminderAlert} = await import('../../notes/controllers/workItemReminder.controller.js');
const require = createRequire(import.meta.url), migration = require('../../../../migrations/20261026-patient-contact-follow-ups.js');
before(async () => {
    await sequelize.authenticate();
    const [rows] = await sequelize.query('SELECT current_database() AS name'); assert.equal((rows[0] as any).name, target.databaseName);
    for (const model of [Tenant, User, Structure, TenantUser, StructureUser]) await (model as any).sync({alter: false});
});
after(async () => {await sequelize.close();});
async function fixture(t: TestContext) {
    const tenantId = randomUUID(), userId = randomUUID(), structureId = randomUUID(), patientId = randomUUID();
    const schema = 'rehablo_' + tenantId.replaceAll('-', ''); let created = false;
    t.after(async () => {
        assert.match(schema, /^rehablo_[a-f0-9]{32}$/);
        if (created) await sequelize.query(`DROP SCHEMA "${schema}" CASCADE`);
        await StructureUser.destroy({where: {structureId}}); await TenantUser.destroy({where: {tenantId}});
        await Structure.destroy({where: {id: structureId}}); await User.destroy({where: {id: userId}}); await Tenant.destroy({where: {id: tenantId}});
    });
    await Tenant.create({id: tenantId, license: 'synthetic', idStripe: 'synthetic', maxUserQuantity: 1, maxStructureQuantity: 1});
    await User.create({id: userId, email: `${userId}@synthetic.test`, password: 'synthetic-only', isActive: true});
    await Structure.create({id: structureId, tenantId, name: 'Synthetic site'});
    await TenantUser.create({tenantId, userId, role: RoleCode.OWNER}); await StructureUser.create({structureId, userId, role: RoleCode.OWNER});
    await sequelize.query(`CREATE SCHEMA "${schema}"`); created = true;
    for (const model of [Patient, Reminder, ReminderAssignment, ReminderAlertState, PatientContactFollowUp]) await (model as any).schema(schema).sync({alter: false});
    await Patient.schema(schema).create({id: patientId, tenantId, userId, structureId, name: 'Synthetic patient', privacyConsent: true});
    const request = (): any => ({tenantSchema: schema, params: {patientId}, body: {action: 'remind'}, query: {},
        user: {sub: userId, tid: tenantId, sid: structureId, isSuperAdmin: true}, access: {scope: 'tenant', userId, structureId}});
    return {tenantId, userId, structureId, patientId, schema, request};
}
test('PostgreSQL creates only one personal reminder and preference for concurrent requests', async t => {
    const f = await fixture(t), results = await Promise.all([setPatientContactFollowUp(f.request()), setPatientContactFollowUp(f.request())]);
    assert.equal(results[0].reminder.id, results[1].reminder.id);
    assert.deepEqual(results[0].reminder.assignedUserIds, [f.userId]);
    assert.equal(await Reminder.schema(f.schema).count(), 1); assert.equal(await PatientContactFollowUp.schema(f.schema).count(), 1);
});
test('PostgreSQL patient instance and bulk-update hooks complete follow-ups in the same transaction', async t => {
    const f = await fixture(t); await setPatientContactFollowUp(f.request());
    await sequelize.transaction(async transaction => {
        await Patient.schema(f.schema).update({emails: [{email: 'valid@example.it'}]}, {where: {id: f.patientId}, transaction});
        assert.equal((await Reminder.schema(f.schema).findOne({transaction}))?.status, 'DONE');
    });
    await Patient.schema(f.schema).update({emails: []}, {where: {id: f.patientId}});
    await setPatientContactFollowUp(f.request());
    await assert.rejects(sequelize.transaction(async transaction => {
        const patient = await Patient.schema(f.schema).findByPk(f.patientId, {transaction});
        await patient!.update({phoneNumbers: [{phoneNumber: '3331234567', country: 'it'}]}, {transaction});
        assert.equal(await Reminder.schema(f.schema).count({where: {status: 'OPEN'}, transaction}), 0);
        throw new Error('synthetic rollback');
    }), /synthetic rollback/);
    assert.equal(await Reminder.schema(f.schema).count({where: {status: 'OPEN'}}), 1);
    assert.deepEqual((await Patient.schema(f.schema).findByPk(f.patientId))?.phoneNumbers, []);
});
test('PostgreSQL claims the current daily alert once across concurrent tabs', async t => {
    const f = await fixture(t); await setPatientContactFollowUp(f.request());
    const today = new Date(); today.setUTCDate(today.getUTCDate() - 2);
    await Reminder.schema(f.schema).update({dueAt: today, remindAt: today}, {where: {sourceType: 'PATIENT_MISSING_CONTACTS'}});
    t.mock.timers.enable({apis: ['Date'], now: new Date('2026-11-20T12:00:00Z')});
    const invoke = (req: any): Promise<any[]> => new Promise((resolve, reject) => {
        const res: any = {status() {return this;}, json(body: any) {resolve(body.data); return this;}};
        claimReminderAlerts(req, res, reject);
    });
    const claimed = await Promise.all([invoke(f.request()), invoke(f.request())]);
    assert.equal(claimed[0].length + claimed[1].length, 1); assert.equal(await ReminderAlertState.schema(f.schema).count(), 1);
});
test('PostgreSQL contact migration can run twice without changing existing reminders', async t => {
    const f = await fixture(t); const result = await setPatientContactFollowUp(f.request());
    for (let run = 0; run < 2; run++) await sequelize.transaction(transaction => migration.up(sequelize.getQueryInterface(), {schema: f.schema, transaction}));
    assert.equal(await Reminder.schema(f.schema).count(), 1);
    assert.equal((await Reminder.schema(f.schema).findByPk(result.reminder.id))?.status, 'OPEN');
});
test('PostgreSQL archive completes cancellation even when the update predicate contains the old archive state', async t => {
    const f = await fixture(t); await setPatientContactFollowUp(f.request());
    await sequelize.transaction(async transaction => {
        await Patient.schema(f.schema).update({archivedAt: new Date()}, {where: {id: f.patientId, archivedAt: null}, transaction});
        assert.equal((await Reminder.schema(f.schema).findOne({transaction}))?.status, 'CANCELLED');
    });
});
test('PostgreSQL first claim and explicit snooze serialize without competing alert-state inserts', async t => {
    const f = await fixture(t); const result = await setPatientContactFollowUp(f.request());
    t.mock.timers.enable({apis: ['Date'], now: new Date('2026-11-20T12:00:00Z')});
    const invoke = (handler: any, req: any): Promise<any> => new Promise((resolve, reject) => {
        const res: any = {status() {return this;}, json(body: any) {resolve(body.data); return this;}};
        handler(req, res, reject);
    });
    const req = f.request(); req.params = {reminderId: result.reminder.id}; req.body = {snoozedUntil: '2026-11-20T13:00:00Z'};
    await Promise.all([invoke(claimReminderAlerts, f.request()), invoke(snoozeReminderAlert, req)]);
    assert.equal(await ReminderAlertState.schema(f.schema).count(), 1);
    assert.equal((await ReminderAlertState.schema(f.schema).findOne())?.snoozedUntil?.toISOString(), '2026-11-20T13:00:00.000Z');
    assert.equal((await invoke(claimReminderAlerts, f.request())).length, 0);
});

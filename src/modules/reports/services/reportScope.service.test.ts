import assert from 'node:assert/strict';
import {it, TestContext} from 'node:test';
import {Structure, StructureUser, TenantUser} from '../../auth/models/index.js';
import {getRolePermissions, RoleCode} from '../../auth/rbac/roles.js';
import {getReportAccess, parseReportStructureIds, resolveOptionalReportScope, resolvePersonalReportScope, resolveReportScope} from './reportScope.service.js';

const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
const [a,b,c] = [id(1),id(2),id(3)];
const record = (values: any): any => ({get: (key: string) => values[key]});
function fixture(t: TestContext, base = RoleCode.ADMIN_SECRETARY) {
    const assignments = [{structureId:a,role:null as string|null},{structureId:b,role:null as string|null}];
    const sites = [a,b,c].map((id,index) => record({id,name:`Site ${index}`}));
    t.mock.method(TenantUser, 'findOne', (async () => record({role:base})) as any);
    t.mock.method(StructureUser, 'findAll', (async () => assignments.map(record)) as any);
    t.mock.method(Structure, 'findAll', (async () => sites) as any);
    const req: any = {query:{}, user:{sub:id(9), tid:id(8), sid:a, role:base, perms:getRolePermissions(base)}};
    return {req,assignments};
}
it('administrative reports aggregate only assigned sites and deny a mixed unauthorized selection', async t => {
    const {req} = fixture(t);
    assert.deepEqual((await resolveReportScope(req,{resource:'analytics',action:'read'})).selectedStructureIds,[a,b]);
    req.query.structureIds = [a,c];
    await assert.rejects(resolveReportScope(req,{resource:'analytics',action:'read'}), /non è autorizzata/);
});
it('per-site restrictive overrides and assignment removal narrow reads and exports immediately', async t => {
    const {req,assignments} = fixture(t);
    assignments[1].role = RoleCode.SECRETARY;
    assert.deepEqual((await resolveReportScope(req,{resource:'analytics',action:'export'})).allowedStructureIds,[a]);
    assignments.splice(0,1);
    await assert.rejects(resolveReportScope(req,{resource:'analytics',action:'read'}), /Nessuna sede/);
});
it('a local viewer override never grants an administrative secretary unassigned sites', async t => {
    const {req,assignments} = fixture(t);
    assignments[0].role = RoleCode.VIEWER; req.user.role = RoleCode.VIEWER; req.user.perms = getRolePermissions(RoleCode.VIEWER);
    assert.deepEqual((await resolveReportScope(req,{resource:'accountant_export',action:'read'})).allowedStructureIds,[a,b]);
});
it('tenant viewer retains tenant reports, while a restrictive site override is honored', async t => {
    const {req,assignments} = fixture(t,RoleCode.VIEWER);
    assignments[1].role = RoleCode.THERAPIST;
    assert.deepEqual((await resolveReportScope(req,{resource:'analytics',action:'read'})).allowedStructureIds,[a,c]);
});
it('personal summaries reject foreign operators and sites independently from aggregate permissions', async t => {
    const {req} = fixture(t,RoleCode.THERAPIST);
    t.mock.method(StructureUser, 'findOne', (async () => record({structureId:a})) as any);
    t.mock.method(Structure, 'findOne', (async () => record({id:a,name:'A'})) as any);
    assert.equal((await resolvePersonalReportScope(req)).operatorId,id(9));
    req.query.operatorId=id(10);
    await assert.rejects(resolvePersonalReportScope(req),/tuo calendario/);
    req.query={structureIds:[b]};
    await assert.rejects(resolvePersonalReportScope(req),/sede corrente/);
});
it('normalizes selections and refuses ambiguous or malformed structure filters', () => {
    assert.deepEqual(parseReportStructureIds({structureIds:[b,a,b]}),[a,b]);
    assert.throws(() => parseReportStructureIds({structureIds:[a,b],structureId:a}),/discordanti/);
    assert.throws(() => parseReportStructureIds({structureIds:['invalid']}),/non valida/);
});

it('tenant report visibility never grants a viewer unassigned operational sites', async t => {
    const {req,assignments} = fixture(t,RoleCode.VIEWER);
    assignments.splice(1,1);
    const access = await getReportAccess(req);
    assert.deepEqual(access.allowedStructureIds,[a,b,c]);
    assert.deepEqual(access.operationalStructureIds,[a]);
    req.query.structureIds=[b];
    assert.deepEqual((await getReportAccess(req)).selectedStructureIds,[b]);
    assert.deepEqual((await getReportAccess(req)).operationalStructureIds,[a]);
});
it('operational sites exclude restrictive report overrides without owner or superadmin assignment fallbacks', async t => {
    const {req,assignments} = fixture(t,RoleCode.OWNER);
    assignments.splice(1,1);
    req.user.isSuperAdmin=true;
    assert.deepEqual((await getReportAccess(req)).operationalStructureIds,[a]);
});
it('clinical evidence cannot borrow a local viewer permission for an administrative site', async t => {
    const {req,assignments} = fixture(t);
    assignments[0].role=RoleCode.VIEWER;
    req.user.role=RoleCode.VIEWER;req.user.perms=getRolePermissions(RoleCode.VIEWER);
    const scope=await resolveReportScope(req,{resource:'analytics',action:'read'});
    assert.equal(await resolveOptionalReportScope(req,scope,'protocol'),null);
    assert.equal(await resolveOptionalReportScope(req,{...scope,selectedStructureIds:[a]},'protocol'),'tenant');
    assert.equal(await resolveOptionalReportScope(req,scope,'quote'),'structure');
});
it('optional evidence preserves own restrictions and immediately rejects assignment or membership revocation', async t => {
    const {req,assignments} = fixture(t,RoleCode.VIEWER);
    const scope=await resolveReportScope(req,{resource:'analytics',action:'read'});
    assignments[1].role=RoleCode.THERAPIST;
    assert.equal(await resolveOptionalReportScope(req,{...scope,selectedStructureIds:[a,b]},'protocol'),'own');
    t.mock.method(TenantUser,'findOne',(async()=>null) as any);
    assert.equal(await resolveOptionalReportScope(req,scope,'protocol'),null);
});
it('optional evidence does not bypass missing current permissions', async t => {
    const {req} = fixture(t);
    const scope=await resolveReportScope(req,{resource:'analytics',action:'read'});
    assert.equal(await resolveOptionalReportScope(req,scope,'protocol'),null);
    assert.equal(await resolveOptionalReportScope(req,scope,'quote'),'structure');
});

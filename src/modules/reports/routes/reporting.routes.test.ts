import assert from 'node:assert/strict';
import {it} from 'node:test';
import reportsRouter from './reports.routes.js';
import invoiceRouter from '../../invoice/routes/invoice.routes.js';
import {getRolePermissions, RoleCode} from '../../auth/rbac/roles.js';

const targets: Array<[any, string]> = [
    [reportsRouter, '/reports/analytics/summary'], [reportsRouter, '/reports/analytics/catalog'],
    [reportsRouter, '/reports/analytics/operators'], [reportsRouter, '/reports/receivables'],
    [reportsRouter, '/reports/datasets/:dataset'], [reportsRouter, '/reports/datasets/:dataset/export'],
    [invoiceRouter, '/reports/overview']
];

it('mounted aggregate and compatibility report routes reject base secretaries and clinical roles before reading data', () => {
    for (const [router, path] of targets) {
        const route = router.stack.find((layer: any) => layer.route?.path === path)?.route;
        assert.ok(route, path);
        for (const role of [RoleCode.SECRETARY, RoleCode.THERAPIST, RoleCode.PHYSIATRIST, RoleCode.EXTERNAL_COLLABORATOR]) {
            let status = 0, nextCalled = false;
            const req: any = {user: {sub: 'user', sid: 'site', role, perms: getRolePermissions(role)}};
            const res: any = {status(value: number) {status = value; return this;}, json() {return this;}};
            route.stack[0].handle(req, res, () => nextCalled = true);
            assert.equal(status, 403, `${role}: ${path}`);
            assert.equal(nextCalled, false, `${role}: ${path}`);
        }
    }
});

it('mounted aggregate routes use analytics permissions, including the former overview endpoint', () => {
    for (const [router, path] of targets) {
        const route = router.stack.find((layer: any) => layer.route?.path === path).route;
        let nextCalled = false;
        const req: any = {user: {sub: 'user', sid: 'site', role: RoleCode.ADMIN_SECRETARY, perms: getRolePermissions(RoleCode.ADMIN_SECRETARY)}};
        const res: any = {status() {assert.fail(path);}, json() {assert.fail(path);}};
        route.stack[0].handle(req, res, () => nextCalled = true);
        assert.equal(nextCalled, true, path);
        assert.equal(req.access.resource, 'analytics', path);
    }
});

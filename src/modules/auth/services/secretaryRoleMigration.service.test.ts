import assert from 'node:assert/strict';
import {it} from 'node:test';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const migration = require('../../../../migrations/20261018-secretary-role-separation.js');
it('migrates both role columns once, preserves assignments, and invalidates affected sessions atomically', async () => {
    const queries: string[] = []; let applied = false; const tx = {};
    const db = {transaction: async (work: any) => work(tx), query: async (sql: string, options: any) => {
        queries.push(sql);
        if (sql.startsWith('ALTER TYPE')) {assert.equal(options, undefined); return [[]];}
        assert.equal(options.transaction, tx);
        if (sql.startsWith('SELECT version')) return [applied ? [{version: 'done'}] : []];
        if (sql.includes('WITH tenant_changed')) return [[{userId:'user'}]];
        if (sql.startsWith('INSERT INTO public.auth_schema_migrations')) applied = true;
        return [[]];
    }};
    await migration.up({sequelize: db});
    assert.ok(queries.some(sql => sql.includes('UPDATE public.tenant_users') && sql.includes("WHERE role = 'SECRETARY'")));
    assert.ok(queries.some(sql => sql.includes('UPDATE public.structure_users') && sql.includes("WHERE role = 'SECRETARY'")));
    assert.ok(queries.some(sql => sql.includes('UPDATE public.users SET "authVersion"')));
    assert.ok(queries.some(sql => sql.includes('UPDATE public.refresh_tokens')));
    assert.ok(!queries.some(sql => /DELETE|calendarEnabled|INSERT INTO public.structure_users/.test(sql)));
    const before = queries.length;
    await migration.up({sequelize: db});
    assert.ok(!queries.slice(before).some(sql => /UPDATE|INSERT INTO public.auth_schema_migrations/.test(sql)));
});

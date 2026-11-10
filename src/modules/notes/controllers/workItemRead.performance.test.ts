import assert from 'node:assert/strict';
import {it} from 'node:test';
import {Op} from 'sequelize';
import Note from '../models/note.model.js';
import NoteAssignment from '../models/noteAssignment.model.js';
import Reminder from '../models/reminder.model.js';
import ReminderAssignment from '../models/reminderAssignment.model.js';
import User from '../../auth/models/user.model.js';
import StructureUser from '../../auth/models/structureUser.model.js';
import TenantUser from '../../auth/models/tenantUser.model.js';
import {getNotes} from './workItemNote.controller.js';
import {getReminders} from './workItemReminder.controller.js';

const run = (handler: any, req: any) => new Promise<any>((resolve, reject) => {
    const res: any = {status() {return this;}, json(body: unknown) {resolve(body); return this;}};
    handler(req, res, reject);
});
for (const [label, model, assignment, handler] of [
    ['notes', Note, NoteAssignment, getNotes],
    ['reminders', Reminder, ReminderAssignment, getReminders]
] as const) {
    it(label + ': assigned-to-me reuses visibility IDs without widening empty assignments', async t => {
        t.mock.method(model, 'schema', (() => model) as any);
        t.mock.method(assignment, 'schema', (() => assignment) as any);
        const lookups = t.mock.method(assignment, 'findAll', (async () => []) as any);
        let filtered: any;
        t.mock.method(model, 'findAll', (async (options: any) => {filtered = options.where; return []}) as any);
        t.mock.method(StructureUser, 'findAll', (async () => []) as any);
        t.mock.method(TenantUser, 'findAll', (async () => []) as any);
        t.mock.method(User, 'findAll', (async () => []) as any);
        const result = await run(handler, {query: {assignedToMe: 'true'}, tenantSchema: 'rehablo_test',
            access: {userId: 'synthetic-user', structureId: 'synthetic-structure'},
            user: {id: 'synthetic-user', tid: 'synthetic-tenant'}});
        assert.equal(lookups.mock.callCount(), 1, 'filter and visibility must share the same assignment read');
        const base = filtered[Op.and].find((part: any) => part.structureId);
        assert.equal(base.structureId, 'synthetic-structure');
        assert.deepEqual(base.id[Op.in], [], 'no assignments must remain an empty selection');
        assert.ok(result);
    });
}

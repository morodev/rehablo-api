import {BillingAccount} from '../../billing/models/billing.model.js';
import assert from 'node:assert/strict';
import {it, TestContext} from 'node:test';
import bcrypt from 'bcryptjs';
import {sequelize} from '../../../config/database.js';
import {Tenant, TenantUser, User, UserEmail} from '../models/index.js';
import {errorHandler} from '../../../middleware/errorHandler.js';
import {createUser} from './user.controller.js';
import {isEmailUniqueConstraintError} from '../services/teamMemberEmailConflict.service.js';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const existingUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';

function record(data: Record<string, unknown>): any {
    return {get: (key: string) => data[key], ...data};
}

function run(handler: any, req: any): Promise<any> {
    return new Promise((resolve) => {
        const res: any = {
            statusCode: 200,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(body: any) {
                resolve({status: this.statusCode, body});
                return this;
            }
        };
        handler(req, res, (error: any) => resolve({status: 500, body: {message: error?.message}}));
    });
}

function duplicateFixture(t: TestContext, membership: any): {req: any; normalizedEmails: string[]} {
    const normalizedEmails: string[] = [];
    t.mock.method(Tenant, 'findByPk', (async () => record({id: tenantId})) as any);
    t.mock.method(UserEmail, 'findOne', (async ({where}: any) => {
        normalizedEmails.push(where.normalizedEmail);
        return record({userId: existingUserId});
    }) as any);
    t.mock.method(User, 'findByPk', (async () => record({id: existingUserId})) as any);
    t.mock.method(TenantUser, 'findOne', (async () => membership) as any);
    t.mock.method(User, 'create', (async () => {
        throw new Error('User.create non deve essere chiamato per una mail duplicata');
    }) as any);

    return {
        normalizedEmails,
        req: {
            user: {tid: tenantId},
            body: {email: '  DUPLICATA@Example.COM ', password: 'password-sicura'}
        }
    };
}

for (const conflict of [
    {
        membership: record({deactivatedAt: null}),
        code: 'EMAIL_ALREADY_IN_TEAM',
        message: 'Questa email appartiene già a un membro del team.'
    },
    {
        membership: record({deactivatedAt: new Date('2026-01-01T00:00:00Z')}),
        code: 'EMAIL_MEMBER_DEACTIVATED',
        message: 'Questa email appartiene a un membro rimosso dal team. Riattivalo dalla lista.'
    },
    {
        membership: null,
        code: 'EMAIL_ALREADY_REGISTERED',
        message: 'Esiste già un account Rehablo con questa email. Usa un indirizzo diverso.'
    }
]) {
    it(`createUser returns the stable ${conflict.code} contract before creating an account`, async (t) => {
        const fixture = duplicateFixture(t, conflict.membership);
        const result = await run(createUser, fixture.req);

        assert.equal(result.status, 409);
        assert.equal(result.body.message, conflict.message);
        assert.deepEqual(result.body.error, {code: conflict.code, field: 'email'});
        assert.deepEqual(fixture.normalizedEmails, ['duplicata@example.com']);
        assert.equal((User.create as any).mock.callCount(), 0);
    });
}

it('recognizes only email-related Sequelize unique constraint races', () => {
    assert.equal(isEmailUniqueConstraintError({
        name: 'SequelizeUniqueConstraintError',
        errors: [{path: 'email'}]
    }), true);
    assert.equal(isEmailUniqueConstraintError({
        name: 'SequelizeUniqueConstraintError',
        fields: {normalizedEmail: 'duplicata@example.com'}
    }), true);
    assert.equal(isEmailUniqueConstraintError({
        name: 'SequelizeUniqueConstraintError',
        errors: [{path: 'externalId'}]
    }), false);
});

it('createUser translates an email unique race after the pre-check into the stable team conflict', async (t) => {
    t.mock.method(BillingAccount, 'findByPk', (async () => null) as any);
    const structureId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003';
    let identityLookup = 0;
    t.mock.method(Tenant, 'findByPk', (async () => record({
        id: tenantId,
        getStructures: async () => [record({id: structureId})]
    })) as any);
    t.mock.method(UserEmail, 'findOne', (async () => {
        identityLookup++;
        return identityLookup === 1 ? null : record({userId: existingUserId});
    }) as any);
    t.mock.method(User, 'findOne', (async () => null) as any);
    t.mock.method(User, 'findByPk', (async () => record({id: existingUserId})) as any);
    t.mock.method(TenantUser, 'findOne', (async () => record({deactivatedAt: null})) as any);
    t.mock.method(bcrypt, 'hash', (async () => '$2a$12$hash') as any);
    t.mock.method(sequelize, 'query', (async (sql: string) => {if (!sql.includes('activities-membership-gate')) throw new Error('Unexpected unmocked SQL in unit fixture'); return [[], {}];}) as any);
    t.mock.method(sequelize, 'transaction', (async (callback: any) => callback({LOCK: {UPDATE: 'UPDATE'}})) as any);
    t.mock.method(User, 'create', (async () => {
        throw {name: 'SequelizeUniqueConstraintError', errors: [{path: 'email'}]};
    }) as any);

    const result = await run(createUser, {
        user: {tid: tenantId, sid: structureId},
        body: {
            name: 'Mario', surname: 'Rossi', email: 'duplicata@example.com',
            password: 'password-sicura', calendarColor: 'bg-blue-500'
        }
    });

    assert.equal(result.status, 409);
    assert.equal(result.body.message, 'Questa email appartiene già a un membro del team.');
    assert.deepEqual(result.body.error, {code: 'EMAIL_ALREADY_IN_TEAM', field: 'email'});
    assert.equal(identityLookup, 2);
});

it('global unique constraint responses never expose the rejected instance or password hash', (t) => {
    t.mock.method(console, 'warn', () => undefined);
    const response: any = {
        statusCode: 200,
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        json(body: any) {
            this.body = body;
            return this;
        }
    };
    const error = {
        name: 'SequelizeUniqueConstraintError',
        fields: {email: 'duplicata@example.com'},
        errors: [{
            path: 'email',
            value: 'duplicata@example.com',
            instance: {email: 'duplicata@example.com', password: '$2a$12$hash-riservato'}
        }]
    };

    errorHandler(error, {} as any, response, (() => undefined) as any);

    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.body, {
        status: 'error',
        message: 'Dato già utilizzato.',
        error: {code: 'RESOURCE_ALREADY_EXISTS', fields: ['email']}
    });
    assert.equal(JSON.stringify(response.body).includes('hash-riservato'), false);
    assert.equal(JSON.stringify(response.body).includes('duplicata@example.com'), false);
});

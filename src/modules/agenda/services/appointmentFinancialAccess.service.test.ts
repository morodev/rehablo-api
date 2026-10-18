import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Request} from 'express';
import {canAccessAppointmentFinance, canChangeEventTypePricing} from './appointmentFinancialAccess.service.js';

function request(perms: string[]): Request {return {user: {actor: 'staff', id: 'doctor', sub: 'doctor', sid: 'site', permissions: perms},
    access: {userId: 'doctor', structureId: 'site'}} as unknown as Request;}

test('own financial rights never apply to another calendar or site', () => {
    const req = request(['payment:create:own']);
    assert.equal(canAccessAppointmentFinance(req, {calendarId: 'doctor', structureId: 'site'}, 'payment', 'create'), true);
    assert.equal(canAccessAppointmentFinance(req, {calendarId: 'other', structureId: 'site'}, 'payment', 'create'), false);
    assert.equal(canAccessAppointmentFinance(req, {calendarId: 'doctor', structureId: 'other'}, 'payment', 'create'), false);
});

test('agenda or own price permissions cannot change the prices of reusable appointment types', () => {
    for (const perms of [['agenda:manage:structure'], ['appointment_pricing:update:own']]) {
        const req = request(perms);
        assert.equal(canChangeEventTypePricing(req, {price: 80}), false);
        assert.equal(canChangeEventTypePricing(req, {linkedServiceId: 'service'}), false);
        assert.equal(canChangeEventTypePricing(req, {price: '80', linkedServiceId: null, title: 'Updated'}, {price: 80}), true);
        assert.equal(canChangeEventTypePricing(req, {price: null}, {price: 80}), false);
    }
    assert.equal(canChangeEventTypePricing(request(['appointment_pricing:update:structure']), {price: 80}), true);
    assert.equal(canChangeEventTypePricing(request([]), {title: 'New type'}), true);
});

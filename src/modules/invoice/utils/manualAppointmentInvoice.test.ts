import assert from 'node:assert/strict';
import {it} from 'node:test';
import {parseManualAppointmentService} from './manualAppointmentInvoice.js';

const body = (manualService: unknown) => ({agendaEventId: 'appointment', manualService});
it('manual entry is opt-in and leaves existing requests untouched', () => {
    assert.deepEqual(parseManualAppointmentService({services: [{id: 'catalogue', quantity: 1}]}), {value: null});
});
it('accepts exact cents despite floating-point representation, trimming only the description', () => {
    for (const amount of [0.01, 0.29, 12.34, 99999999.99]) {
        assert.deepEqual(parseManualAppointmentService(body({description: ' Seduta ', amount})),
            {value: {description: 'Seduta', amount}});
    }
});
for (const amount of [null, undefined, '', '20', NaN, Infinity, -1, 0, 0.001, 1.234, 100000000]) {
    it(`rejects invalid manual amount ${String(amount)}`, () => {
        assert.ok(parseManualAppointmentService(body({description: 'Seduta', amount})).error);
    });
}
for (const manual of [null, [], true, 'Seduta', {}, {description: 10, amount: 10}, {description: ' '.repeat(10), amount: 10}]) {
    it(`rejects malformed manual service ${JSON.stringify(manual)}`, () => {
        assert.ok(parseManualAppointmentService(body(manual)).error);
    });
}
it('cannot combine manual billing with a package even if other package inputs would replace the body', () => {
    assert.ok(parseManualAppointmentService({...body({description: 'Seduta', amount: 10}), carePackageId: 'package'}).error);
});

import assert from 'node:assert/strict';
import {it} from 'node:test';
import {financialAccountChoice} from './financialAccountPolicy.js';
it('auto-selects only an eligible unique or preferred account', () => {
    const accounts = [{id:'cash',structureId:'site'}, {id:'bank',structureId:null}, {id:'foreign',structureId:'other'},
        {id:'inactive',structureId:'site',isActive:false}, {id:'usd',structureId:'site',currency:'USD'}];
    assert.equal(financialAccountChoice(accounts,'site','bank').defaultAccountId,'bank');
    assert.equal(financialAccountChoice(accounts,'site','foreign').selectionRequired,true);
    assert.equal(financialAccountChoice(accounts,'site','inactive').selectionRequired,true);
    assert.deepEqual(financialAccountChoice(accounts.slice(0,1),'site').defaultAccountId,'cash');
    assert.equal(financialAccountChoice([], 'site').willCreateDefaultAccount,true);
});

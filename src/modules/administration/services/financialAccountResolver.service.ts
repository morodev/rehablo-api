import {Op, Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {Tenant} from '../../auth/models/index.js';
import {FinancialAccount, PaymentMethod} from '../models/index.js';
import {financialAccountChoice} from './financialAccountPolicy.js';
import {nullableTreasuryUuid, treasuryError} from './treasuryValidation.service.js';

function tenantId(schema: string): string {
    const value = /^rehablo_([a-f0-9]{32})$/i.exec(schema)?.[1];
    if (!value) treasuryError('Schema finanziario non valido', 422);
    return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}
export async function lockFinancialAccounts(schema: string, structureId: string, transaction: Transaction) {
    if (!transaction) treasuryError('La registrazione finanziaria richiede una transazione', 500);
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))', {
        transaction, replacements: {lockKey: `${schema}:financial-accounts:${structureId}`}});
}
export async function financialAccountOptions(schema: string, structureId: string, transaction?: Transaction) {
    const [accounts, tenant] = await Promise.all([
        FinancialAccount.schema(schema).findAll({where: {isActive: true, currency: 'EUR', [Op.or]: [{structureId}, {structureId: null}]},
            order: [['name', 'ASC']], transaction}),
        Tenant.findByPk(tenantId(schema), {attributes: ['id', 'administrationSettings'], transaction})
    ]);
    const settings = (tenant?.get('administrationSettings') ?? {}) as any;
    return financialAccountChoice(accounts.map(account => account.get({plain: true}) as any), structureId,
        settings.treasury?.defaultAccountByStructureId?.[structureId]);
}

/** Called under the writer transaction; holds the account lock through its cash entry. */
export async function resolveFinancialAccount(schema: string, structureId: string,
    requestedAccountId: string | null | undefined, transaction: Transaction): Promise<string> {
    await lockFinancialAccounts(schema, structureId, transaction);
    const explicit = nullableTreasuryUuid(requestedAccountId, 'Conto');
    let id = explicit;
    if (!id) {
        const options = await financialAccountOptions(schema, structureId, transaction);
        if (options.selectionRequired) treasuryError('Seleziona il conto su cui registrare il movimento', 422);
        id = options.defaultAccountId;
        if (!id) {
            const created = await FinancialAccount.schema(schema).create({structureId, name: 'Cassa principale', type: 'CASH',
                currency: 'EUR', openingBalance: 0, isActive: true, metadata: {automatic: true}}, {transaction});
            id = String(created.get('id'));
        }
    }
    const locked = await FinancialAccount.schema(schema).findOne({where: {id, isActive: true},
        transaction, lock: transaction.LOCK.UPDATE});
    if (!locked || (locked.get('structureId') && locked.get('structureId') !== structureId)
        || (locked.get('currency') ?? 'EUR') !== 'EUR')
        treasuryError('Il conto selezionato non è disponibile per questa sede', 422);
    return id;
}

export async function readFinancialOptions(schema: string, structureId: string) {
    const [choice, methods] = await Promise.all([financialAccountOptions(schema, structureId),
        PaymentMethod.schema(schema).findAll({where: {isActive: true}, order: [['label', 'ASC']],
            attributes: ['id', 'code', 'label', 'type', 'isTraceable']})]);
    return {...choice, structureId, accounts: choice.accounts.map(({id, name, type, structureId: site}) =>
        ({id, name, type, structureId: site ?? null})), paymentMethods: methods.map(method => method.get({plain: true}))};
}

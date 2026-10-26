import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';
export class FinancialOperation extends Model {}
FinancialOperation.init({
    id: {type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4},
    idempotencyKey: {type: DataTypes.STRING(128), allowNull: false},
    kind: {type: DataTypes.STRING(64), allowNull: false},
    requestHash: {type: DataTypes.STRING(64), allowNull: false},
    createdByUserId: {type: DataTypes.UUID, allowNull: false},
    structureId: {type: DataTypes.UUID, allowNull: false},
    result: {type: DataTypes.JSONB, allowNull: false}
}, {sequelize, modelName: 'financialOperation', tableName: 'financial_operations', updatedAt: false,
    indexes: [{name: 'financial_operations_key_unique', unique: true, fields: ['idempotencyKey']}],
    hooks: {beforeUpdate() {throw new Error('Una registrazione finanziaria è immutabile');},
        beforeDestroy() {throw new Error('Una registrazione finanziaria non può essere eliminata');}}});

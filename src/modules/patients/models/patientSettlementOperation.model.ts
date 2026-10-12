import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';

/** One immutable retry identity for an atomic cash/credit allocation, scoped to the tenant. */
export class PatientSettlementOperation extends Model {}
PatientSettlementOperation.init({
    id: {type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4},
    patientId: {type: DataTypes.UUID, allowNull: false},
    structureId: {type: DataTypes.UUID, allowNull: false},
    idempotencyKey: {type: DataTypes.STRING(128), allowNull: false},
    requestHash: {type: DataTypes.STRING(64), allowNull: false},
    result: {type: DataTypes.JSONB, allowNull: false},
    createdByUserId: {type: DataTypes.UUID, allowNull: false}
}, {sequelize, modelName: 'patientSettlementOperation', tableName: 'patient_settlement_operations', updatedAt: false,
    indexes: [{name: 'patient_settlement_operations_key_unique', unique: true, fields: ['idempotencyKey']},
        {name: 'patient_settlement_operations_patient_date_idx', fields: ['patientId', 'structureId', 'createdAt']}],
    hooks: {beforeUpdate() {throw new Error('Una registrazione di saldo è immutabile');},
        beforeDestroy() {throw new Error('Una registrazione di saldo non può essere eliminata');}}});

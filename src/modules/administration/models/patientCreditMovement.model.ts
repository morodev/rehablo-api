import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../../config/database.js';

/** Immutable record of a credit applied to care or returned to the patient. */
export class PatientCreditMovement extends Model {}
PatientCreditMovement.init({
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    creditId: { type: DataTypes.UUID, allowNull: false },
    type: { type: DataTypes.STRING(24), allowNull: false },
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    targetId: { type: DataTypes.UUID, allowNull: true },
    invoicePaymentId: { type: DataTypes.UUID, allowNull: true },
    treasuryMovementId: { type: DataTypes.UUID, allowNull: true },
    reversalOfId: { type: DataTypes.UUID, allowNull: true, unique: true },
    idempotencyKey: { type: DataTypes.STRING(128), allowNull: false, unique: true },
    createdByUserId: { type: DataTypes.UUID, allowNull: false }
}, { sequelize, modelName: 'patientCreditMovement', tableName: 'patient_credit_movements', updatedAt: false,
    indexes: [{ fields: ['creditId', 'createdAt'] }] });

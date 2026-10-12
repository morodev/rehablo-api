import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export type AccountActionPurpose = 'verify_email' | 'reset_password';
interface AccountActionTokenAttributes {
    id: string;
    userId: string;
    tokenHash: string;
    purpose: AccountActionPurpose;
    normalizedEmail: string;
    expiresAt: Date;
    consumedAt: Date | null;
    invalidatedAt: Date | null;
}
export class AccountActionToken extends Model<AccountActionTokenAttributes,
    Optional<AccountActionTokenAttributes, 'id' | 'consumedAt' | 'invalidatedAt'>> {
    declare id: string;
    declare userId: string;
    declare tokenHash: string;
    declare purpose: AccountActionPurpose;
    declare normalizedEmail: string;
    declare expiresAt: Date;
    declare consumedAt: Date | null;
    declare invalidatedAt: Date | null;
}

AccountActionToken.init({
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    tokenHash: { type: DataTypes.STRING(64), allowNull: false },
    purpose: { type: DataTypes.STRING(32), allowNull: false, validate: { isIn: [['verify_email', 'reset_password']] } },
    normalizedEmail: { type: DataTypes.STRING(320), allowNull: false },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    consumedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    invalidatedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null }
}, {
    sequelize, modelName: 'accountActionToken', tableName: 'account_action_tokens', schema: 'public',
    indexes: [
        { name: 'account_action_tokens_hash_uq', unique: true, fields: ['tokenHash'] },
        { name: 'account_action_tokens_user_purpose_idx', fields: ['userId', 'purpose'] },
        { name: 'account_action_tokens_expiry_idx', fields: ['expiresAt'] }
    ]
});
export default AccountActionToken;

import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface UserEmailAttributes {
    id: string;
    userId: string;
    email: string;
    normalizedEmail: string;
    isPrimary: boolean;
    verifiedAt?: Date | null;
}

export type UserEmailCreationAttributes = Optional<
    UserEmailAttributes,
    'id' | 'isPrimary' | 'verifiedAt'
>;

/**
 * Indirizzi verificati utilizzabili per autenticare una singola identità Rehablo.
 *
 * `normalizedEmail` è globalmente univoco: due account non possono rivendicare la stessa
 * casella. Il centro continua a vedere esclusivamente l'indirizzo salvato nella propria
 * anagrafica paziente, non l'elenco globale degli alias.
 */
export class UserEmail
    extends Model<UserEmailAttributes, UserEmailCreationAttributes>
    implements UserEmailAttributes {
    declare id: string;
    declare userId: string;
    declare email: string;
    declare normalizedEmail: string;
    declare isPrimary: boolean;
    declare verifiedAt: Date | null;
}

UserEmail.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        userId: { type: DataTypes.UUID, allowNull: false },
        email: { type: DataTypes.STRING, allowNull: false },
        normalizedEmail: { type: DataTypes.STRING, allowNull: false, unique: true },
        isPrimary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        verifiedAt: { type: DataTypes.DATE, allowNull: true }
    },
    {
        sequelize,
        modelName: 'userEmail',
        tableName: 'user_emails',
        indexes: [{ fields: ['userId'] }]
    }
);

export function normalizeIdentityEmail(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export default UserEmail;

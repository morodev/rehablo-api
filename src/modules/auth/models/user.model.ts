import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface UserAttributes {
    id: string;
    name?: string | null;
    surname?: string | null;
    email: string;
    password: string;
    calendarVisible: boolean;
    calendarColor: string;
    isActive: boolean;
    isSuperAdmin: boolean;
    isTenant: boolean;
    isPremium: boolean;
}

export type UserCreationAttributes = Optional<
    UserAttributes,
    'id' | 'calendarVisible' | 'calendarColor' | 'isActive' | 'isSuperAdmin' | 'isTenant' | 'isPremium'
>;

export class User extends Model<UserAttributes, UserCreationAttributes> implements UserAttributes {
    declare id: string;
    declare name: string | null;
    declare surname: string | null;
    declare email: string;
    declare password: string;
    declare calendarVisible: boolean;
    declare calendarColor: string;
    declare isActive: boolean;
    declare isSuperAdmin: boolean;
    declare isTenant: boolean;
    declare isPremium: boolean;
}

User.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        name: { type: DataTypes.STRING, allowNull: true },
        surname: { type: DataTypes.STRING, allowNull: true },
        email: { type: DataTypes.STRING, allowNull: false, unique: true },
        password: { type: DataTypes.STRING, allowNull: false },
        calendarVisible: { type: DataTypes.BOOLEAN, defaultValue: true },
        calendarColor: { type: DataTypes.STRING, allowNull: false, defaultValue: 'bg-primary' },
        isActive: { type: DataTypes.BOOLEAN, defaultValue: false },
        isSuperAdmin: { type: DataTypes.BOOLEAN, defaultValue: false },
        isTenant: { type: DataTypes.BOOLEAN, defaultValue: false },
        isPremium: { type: DataTypes.BOOLEAN, defaultValue: false }
    },
    {
        sequelize,
        modelName: 'user',
        tableName: 'users',
        defaultScope: {
            attributes: { exclude: [] }
        },
        scopes: {
            withoutPassword: { attributes: { exclude: ['password'] } }
        }
    }
);

export default User;


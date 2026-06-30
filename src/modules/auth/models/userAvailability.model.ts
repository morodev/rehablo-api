import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface UserAvailabilityAttributes {
    id: string;
    day: number;
    enabled: boolean | null;
    rangeOneStart: string | null;
    rangeOneFinish: string | null;
    rangeTwoStart: string | null;
    rangeTwoFinish: string | null;
    rangeThreeStart: string | null;
    rangeThreeFinish: string | null;
    rangeFourStart: string | null;
    rangeFourFinish: string | null;
    userId: string;
}

export type UserAvailabilityCreationAttributes = Optional<UserAvailabilityAttributes, 'id'>;

export class UserAvailability
    extends Model<UserAvailabilityAttributes, UserAvailabilityCreationAttributes>
    implements UserAvailabilityAttributes {
    declare id: string;
    declare day: number;
    declare enabled: boolean | null;
    declare rangeOneStart: string | null;
    declare rangeOneFinish: string | null;
    declare rangeTwoStart: string | null;
    declare rangeTwoFinish: string | null;
    declare rangeThreeStart: string | null;
    declare rangeThreeFinish: string | null;
    declare rangeFourStart: string | null;
    declare rangeFourFinish: string | null;
    declare userId: string;
}

const timeField = { type: DataTypes.TIME, allowNull: true };

UserAvailability.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        day: { type: DataTypes.INTEGER, allowNull: false },
        enabled: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
        rangeOneStart: timeField,
        rangeOneFinish: timeField,
        rangeTwoStart: timeField,
        rangeTwoFinish: timeField,
        rangeThreeStart: timeField,
        rangeThreeFinish: timeField,
        rangeFourStart: timeField,
        rangeFourFinish: timeField,
        userId: { type: DataTypes.UUID, allowNull: false }
    },
    { sequelize, modelName: 'userAvailability', tableName: 'user_availabilities' }
);

export default UserAvailability;


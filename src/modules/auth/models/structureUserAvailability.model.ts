import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { UserAvailabilityAttributes, USER_AVAILABILITY_TIME_COLUMNS } from './userAvailability.model.js';

export interface StructureUserAvailabilityAttributes extends UserAvailabilityAttributes { structureId: string; }
export class StructureUserAvailability extends Model<StructureUserAvailabilityAttributes, Optional<StructureUserAvailabilityAttributes, 'id'>> {
    declare id: string;
    declare userId: string;
    declare structureId: string;
    declare day: number;
    declare enabled: boolean | null;
}
StructureUserAvailability.init({
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    structureId: { type: DataTypes.UUID, allowNull: false },
    day: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 0, max: 6 } },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ...Object.fromEntries(USER_AVAILABILITY_TIME_COLUMNS.map(field => [field, { type: DataTypes.TIME, allowNull: true }]))
} as any, {
    sequelize, modelName: 'structureUserAvailability', tableName: 'structure_user_availabilities',
    indexes: [{ name: 'structure_user_availability_day_unique', unique: true, fields: ['userId', 'structureId', 'day'] }]
});
export default StructureUserAvailability;

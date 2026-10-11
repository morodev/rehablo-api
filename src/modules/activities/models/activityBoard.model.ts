import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';

/** Tenant-scoped; always use .schema(context.tenantSchema). */
export class ActivityBoard extends Model {
    declare id: string;
    declare structureId: string;
    declare timezone: string;
    declare orderRevision: number;
    declare snapshotRevision: number;
    declare createdAt: Date;
    declare updatedAt: Date;
}

ActivityBoard.init({
    id: {type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true},
    structureId: {type: DataTypes.UUID, allowNull: false, unique: 'activity_boards_structure_unique'},
    timezone: {type: DataTypes.STRING(96), allowNull: false, defaultValue: 'Europe/Rome'},
    orderRevision: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, validate: {min: 0}},
    snapshotRevision: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, validate: {min: 0}}
}, {
    sequelize,
    modelName: 'activityBoard',
    tableName: 'activity_boards',
    timestamps: true
});

export default ActivityBoard;

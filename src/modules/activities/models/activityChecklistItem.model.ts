import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';

/** Tenant-scoped; always use .schema(context.tenantSchema). */
export class ActivityChecklistItem extends Model {
    declare id: string;
    declare activityId: string;
    declare executionId: string | null;
    declare createdByUserId: string;
    declare text: string;
    declare position: string;
    declare checked: boolean;
    declare checkedByUserId: string | null;
    declare checkedAt: Date | null;
    declare version: number;
    declare createdAt: Date;
    declare updatedAt: Date;
}

ActivityChecklistItem.init({
    id: {type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true},
    activityId: {type: DataTypes.UUID, allowNull: false},
    executionId: {type: DataTypes.UUID, allowNull: true},
    createdByUserId: {type: DataTypes.UUID, allowNull: false},
    text: {type: DataTypes.STRING(300), allowNull: false, validate: {len: [1, 300]}},
    position: {type: DataTypes.BIGINT, allowNull: false, defaultValue: '0'},
    checked: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false},
    checkedByUserId: {type: DataTypes.UUID, allowNull: true},
    checkedAt: {type: DataTypes.DATE, allowNull: true},
    version: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, validate: {min: 1}}
}, {
    sequelize,
    modelName: 'activityChecklistItem',
    tableName: 'activity_checklist_items',
    timestamps: true
});

export default ActivityChecklistItem;

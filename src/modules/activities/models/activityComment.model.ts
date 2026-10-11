import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';

/** Tenant-scoped; always use .schema(context.tenantSchema). */
export class ActivityComment extends Model {
    declare id: string;
    declare activityId: string;
    declare authorUserId: string;
    declare text: string | null;
    declare version: number;
    declare editedAt: Date | null;
    declare deletedAt: Date | null;
    declare createdAt: Date;
    declare updatedAt: Date;
}

ActivityComment.init({
    id: {type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true},
    activityId: {type: DataTypes.UUID, allowNull: false},
    authorUserId: {type: DataTypes.UUID, allowNull: false},
    text: {type: DataTypes.TEXT, allowNull: true, validate: {len: [1, 5000]}},
    version: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, validate: {min: 1}},
    editedAt: {type: DataTypes.DATE, allowNull: true},
    deletedAt: {type: DataTypes.DATE, allowNull: true}
}, {
    sequelize,
    modelName: 'activityComment',
    tableName: 'activity_comments',
    timestamps: true
});

export default ActivityComment;


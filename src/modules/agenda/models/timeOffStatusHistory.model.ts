import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { TIME_OFF_STATUSES, TimeOffStatus } from './timeOffRequest.model.js';

export interface TimeOffStatusHistoryAttributes {
    id: string;
    timeOffRequestId: string;
    fromStatus?: TimeOffStatus | null;
    toStatus: TimeOffStatus;
    actorUserId: string;
    note?: string | null;
    createdAt?: Date;
}

export type TimeOffStatusHistoryCreationAttributes = Optional<
    TimeOffStatusHistoryAttributes,
    'id' | 'fromStatus' | 'note' | 'createdAt'
>;

/** Append-only audit log delle transizioni di una richiesta di assenza. */
export class TimeOffStatusHistory
    extends Model<TimeOffStatusHistoryAttributes, TimeOffStatusHistoryCreationAttributes>
    implements TimeOffStatusHistoryAttributes {
    declare id: string;
    declare timeOffRequestId: string;
    declare fromStatus: TimeOffStatus | null;
    declare toStatus: TimeOffStatus;
    declare actorUserId: string;
    declare note: string | null;
    declare createdAt: Date;
}

TimeOffStatusHistory.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        timeOffRequestId: { type: DataTypes.UUID, allowNull: false },
        fromStatus: {
            type: DataTypes.STRING(32),
            allowNull: true,
            validate: { isIn: [Array.from(TIME_OFF_STATUSES)] }
        },
        toStatus: {
            type: DataTypes.STRING(32),
            allowNull: false,
            validate: { isIn: [Array.from(TIME_OFF_STATUSES)] }
        },
        actorUserId: { type: DataTypes.UUID, allowNull: false },
        note: { type: DataTypes.TEXT, allowNull: true }
    },
    {
        sequelize,
        modelName: 'timeOffStatusHistory',
        tableName: 'time_off_status_history',
        updatedAt: false,
        indexes: [
            {
                name: 'time_off_history_request_created_idx',
                fields: ['timeOffRequestId', 'createdAt']
            }
        ]
    }
);

export default TimeOffStatusHistory;

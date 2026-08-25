import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export const TIME_OFF_TYPES = ['VACATION', 'PERMISSION', 'SICK_LEAVE', 'TRAINING', 'OTHER'] as const;
export type TimeOffType = (typeof TIME_OFF_TYPES)[number];

export const TIME_OFF_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'REVOKED'] as const;
export type TimeOffStatus = (typeof TIME_OFF_STATUSES)[number];

export interface TimeOffRequestAttributes {
    id: string;
    /** Nullable solo per record legacy non assegnabili con certezza a una sede. */
    structureId?: string | null;
    /** Operatore assente: è l'owner del record ai fini RBAC. */
    userId: string;
    type: TimeOffType;
    status: TimeOffStatus;
    start: Date;
    end: Date;
    allDay: boolean;
    reason?: string | null;
    requestedByUserId: string;
    reviewedByUserId?: string | null;
    reviewedAt?: Date | null;
    reviewNote?: string | null;
    /** Id dell'AgendaEvent convertito, usato per rendere idempotente la migrazione legacy. */
    legacyAgendaEventId?: string | null;
}

export type TimeOffRequestCreationAttributes = Optional<
    TimeOffRequestAttributes,
    | 'id'
    | 'status'
    | 'allDay'
    | 'reason'
    | 'reviewedByUserId'
    | 'reviewedAt'
    | 'reviewNote'
    | 'legacyAgendaEventId'
>;

/** Tenant-scoped model: always access through `TimeOffRequest.schema(req.tenantSchema)`. */
export class TimeOffRequest
    extends Model<TimeOffRequestAttributes, TimeOffRequestCreationAttributes>
    implements TimeOffRequestAttributes {
    declare id: string;
    declare structureId: string | null;
    declare userId: string;
    declare type: TimeOffType;
    declare status: TimeOffStatus;
    declare start: Date;
    declare end: Date;
    declare allDay: boolean;
    declare reason: string | null;
    declare requestedByUserId: string;
    declare reviewedByUserId: string | null;
    declare reviewedAt: Date | null;
    declare reviewNote: string | null;
    declare legacyAgendaEventId: string | null;
}

TimeOffRequest.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        structureId: { type: DataTypes.UUID, allowNull: true },
        userId: { type: DataTypes.UUID, allowNull: false },
        type: {
            type: DataTypes.STRING(32),
            allowNull: false,
            validate: { isIn: [Array.from(TIME_OFF_TYPES)] }
        },
        status: {
            type: DataTypes.STRING(32),
            allowNull: false,
            defaultValue: 'PENDING',
            validate: { isIn: [Array.from(TIME_OFF_STATUSES)] }
        },
        start: { type: DataTypes.DATE, allowNull: false },
        end: { type: DataTypes.DATE, allowNull: false },
        allDay: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        reason: { type: DataTypes.TEXT, allowNull: true },
        requestedByUserId: { type: DataTypes.UUID, allowNull: false },
        reviewedByUserId: { type: DataTypes.UUID, allowNull: true },
        reviewedAt: { type: DataTypes.DATE, allowNull: true },
        reviewNote: { type: DataTypes.TEXT, allowNull: true },
        legacyAgendaEventId: { type: DataTypes.UUID, allowNull: true, unique: true }
    },
    {
        sequelize,
        modelName: 'timeOffRequest',
        tableName: 'time_off_requests',
        indexes: [
            { name: 'time_off_requests_structure_period_idx', fields: ['structureId', 'start', 'end'] },
            { name: 'time_off_requests_user_period_idx', fields: ['userId', 'start', 'end'] },
            { name: 'time_off_requests_status_idx', fields: ['status'] }
        ]
    }
);

export default TimeOffRequest;

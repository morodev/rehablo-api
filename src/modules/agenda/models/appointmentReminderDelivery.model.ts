import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';

/** Tenant-scoped audit. Logical references preserve delivery history when appointments change. */
export class AppointmentReminderDelivery extends Model {
    declare id: string;
}
AppointmentReminderDelivery.init({
    id: {type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4},
    sequence: {type: DataTypes.BIGINT, autoIncrement: true, allowNull: false, unique: true},
    agendaEventId: {type: DataTypes.UUID, allowNull: false},
    occurrenceKey: {type: DataTypes.STRING(40), allowNull: false},
    occurrenceStart: {type: DataTypes.DATE, allowNull: true},
    structureId: {type: DataTypes.UUID, allowNull: true},
    patientId: {type: DataTypes.UUID, allowNull: false},
    channel: {type: DataTypes.STRING(16), allowNull: false},
    recipient: {type: DataTypes.STRING(320), allowNull: false},
    message: {type: DataTypes.TEXT, allowNull: false},
    snapshotHash: {type: DataTypes.STRING(64), allowNull: false},
    status: {type: DataTypes.STRING(16), allowNull: false},
    requestedBy: {type: DataTypes.UUID, allowNull: false},
    idempotencyKey: {type: DataTypes.STRING(128), allowNull: true},
    sentAt: {type: DataTypes.DATE, allowNull: true},
    openedAt: {type: DataTypes.DATE, allowNull: true},
    lastError: {type: DataTypes.TEXT, allowNull: true}
}, {sequelize, modelName: 'appointmentReminderDelivery', tableName: 'appointment_reminder_deliveries', indexes: [
    {name: 'appointment_reminder_occurrence_idx', fields: ['agendaEventId', 'occurrenceKey', 'createdAt']},
    {name: 'appointment_reminder_request_unique', unique: true, fields: ['agendaEventId', 'occurrenceKey', 'channel', 'idempotencyKey']}
]});
export default AppointmentReminderDelivery;

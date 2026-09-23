import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export default class PatientAppointmentRequest extends Model {}

PatientAppointmentRequest.init({
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    patientId: { type: DataTypes.UUID, allowNull: false },
    type: { type: DataTypes.STRING(16), allowNull: false },
    message: { type: DataTypes.TEXT, allowNull: false },
    agendaEventId: { type: DataTypes.UUID, allowNull: true },
    originalStart: { type: DataTypes.DATE, allowNull: true },
    resolvedAgendaEventId: { type: DataTypes.UUID, allowNull: true },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'PENDING' },
    staffNote: { type: DataTypes.TEXT, allowNull: true },
    resolvedAt: { type: DataTypes.DATE, allowNull: true },
    resolvedByUserId: { type: DataTypes.UUID, allowNull: true }
}, { sequelize, modelName: 'patientAppointmentRequest', tableName: 'patient_appointment_requests', indexes: [
    { fields: ['patientId', 'createdAt'] }, { fields: ['status', 'createdAt'] }
] });

import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export default class PatientSharedDocument extends Model {}

PatientSharedDocument.init({
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    patientId: { type: DataTypes.UUID, allowNull: false },
    title: { type: DataTypes.STRING(200), allowNull: false },
    fileName: { type: DataTypes.STRING(255), allowNull: false },
    mimeType: { type: DataTypes.STRING(32), allowNull: false },
    sizeBytes: { type: DataTypes.INTEGER, allowNull: false },
    storagePath: { type: DataTypes.STRING(500), allowNull: false },
    checksumSha256: { type: DataTypes.STRING(64), allowNull: false },
    publishedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    publishedByUserId: { type: DataTypes.UUID, allowNull: false },
    unpublishedAt: { type: DataTypes.DATE, allowNull: true }
}, { sequelize, modelName: 'patientSharedDocument', tableName: 'patient_shared_documents', indexes: [
    { fields: ['patientId', 'publishedAt'] }
] });

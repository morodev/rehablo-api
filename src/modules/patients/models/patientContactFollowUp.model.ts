import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';

/** Personal prompt preference, isolated by tenant schema and selected site. */
export class PatientContactFollowUp extends Model {}
PatientContactFollowUp.init({
    userId: {type: DataTypes.UUID, primaryKey: true},
    patientId: {type: DataTypes.UUID, primaryKey: true},
    structureId: {type: DataTypes.UUID, primaryKey: true},
    suppressedAt: {type: DataTypes.DATE, allowNull: true},
    reminderId: {type: DataTypes.UUID, allowNull: true}
}, {sequelize, modelName: 'patientContactFollowUp', tableName: 'patient_contact_follow_ups'});

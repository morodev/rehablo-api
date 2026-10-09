import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../../config/database.js';

/** One row means that this viewer hides this calendar in this structure. */
export class CalendarPreference extends Model {
    declare viewerUserId: string;
    declare structureId: string;
    declare calendarId: string;
}
CalendarPreference.init({
    viewerUserId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
    structureId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
    calendarId: { type: DataTypes.UUID, allowNull: false, primaryKey: true }
}, { sequelize, modelName: 'calendarPreference', tableName: 'calendar_preferences' });
export default CalendarPreference;

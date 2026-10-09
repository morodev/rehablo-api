import Note from './note.model.js';
import NoteAssignment from './noteAssignment.model.js';
import NoteImage from './noteImage.model.js';
import Reminder from './reminder.model.js';
import ReminderAlertState from './reminderAlertState.model.js';
import ReminderAssignment from './reminderAssignment.model.js';

export function registerNotesAssociations(): void {
    Note.hasMany(NoteAssignment, {foreignKey: 'noteId', as: 'assignments', onDelete: 'CASCADE'});
    NoteAssignment.belongsTo(Note, {foreignKey: 'noteId'});
    Note.hasMany(NoteImage, {foreignKey: 'noteId', as: 'images', onDelete: 'SET NULL'});
    NoteImage.belongsTo(Note, {foreignKey: 'noteId'});
    Reminder.hasMany(ReminderAssignment, {foreignKey: 'reminderId', as: 'assignments', onDelete: 'CASCADE'});
    ReminderAssignment.belongsTo(Reminder, {foreignKey: 'reminderId'});
    Reminder.hasMany(ReminderAlertState, {foreignKey: 'reminderId', as: 'alertStates', onDelete: 'CASCADE'});
    ReminderAlertState.belongsTo(Reminder, {foreignKey: 'reminderId'});
}

export {Note, NoteAssignment, NoteImage, Reminder, ReminderAlertState, ReminderAssignment};

import ActivityBoard from './activityBoard.model.js';
import Activity from './activity.model.js';
import ActivityAssignment from './activityAssignment.model.js';
import ActivityChecklistItem from './activityChecklistItem.model.js';
import ActivityComment from './activityComment.model.js';
import ActivityHistory from './activityHistory.model.js';
import ActivityAlert from './activityAlert.model.js';
import ActivityDelivery from './activityDelivery.model.js';
import ActivityOperation from './activityOperation.model.js';
import ActivityNotificationActivation from './activityNotificationActivation.model.js';
import ActivityPushTarget from './activityPushTarget.model.js';

let associationsRegistered = false;

/** Called once before tenant provisioning; references stay within each tenant schema. */
export function registerActivitiesAssociations(): void {
    if (associationsRegistered) return;
    ActivityBoard.hasMany(Activity, {foreignKey: 'boardId', as: 'activities', onDelete: 'RESTRICT'});
    Activity.belongsTo(ActivityBoard, {foreignKey: 'boardId', as: 'board', onDelete: 'RESTRICT'});
    Activity.hasMany(ActivityAssignment, {foreignKey: 'activityId', as: 'assignments', onDelete: 'CASCADE'});
    ActivityAssignment.belongsTo(Activity, {foreignKey: 'activityId'});
    Activity.hasMany(ActivityChecklistItem, {foreignKey: 'activityId', as: 'checklist', onDelete: 'CASCADE'});
    ActivityChecklistItem.belongsTo(Activity, {foreignKey: 'activityId'});
    Activity.hasMany(ActivityComment, {foreignKey: 'activityId', as: 'comments', onDelete: 'CASCADE'});
    ActivityComment.belongsTo(Activity, {foreignKey: 'activityId'});
    Activity.hasMany(ActivityHistory, {foreignKey: 'activityId', as: 'history', onDelete: 'CASCADE'});
    ActivityHistory.belongsTo(Activity, {foreignKey: 'activityId'});
    Activity.hasOne(ActivityAlert, {foreignKey: 'activityId', as: 'alert', onDelete: 'CASCADE'});
    ActivityAlert.belongsTo(Activity, {foreignKey: 'activityId'});
    ActivityAlert.hasMany(ActivityDelivery, {foreignKey: 'alertId', as: 'deliveries', onDelete: 'CASCADE'});
    ActivityDelivery.belongsTo(ActivityAlert, {foreignKey: 'alertId'});
    ActivityBoard.hasMany(ActivityOperation, {foreignKey: 'boardId', as: 'operations', onDelete: 'CASCADE'});
    ActivityOperation.belongsTo(ActivityBoard, {foreignKey: 'boardId'});
    // Match the versioned delivery migration; delivery UUIDs are immutable.
    ActivityDelivery.hasMany(ActivityPushTarget, {foreignKey: 'deliveryId', as: 'pushTargets', onDelete: 'CASCADE', onUpdate: 'NO ACTION'});
    ActivityPushTarget.belongsTo(ActivityDelivery, {foreignKey: 'deliveryId', onDelete: 'CASCADE', onUpdate: 'NO ACTION'});
    associationsRegistered = true;
}

/** Parent-before-child order is required by empty-tenant provisioning. */
export const ACTIVITIES_MODELS = [
    ActivityBoard, Activity, ActivityAssignment, ActivityChecklistItem, ActivityComment,
    ActivityHistory, ActivityAlert, ActivityDelivery, ActivityOperation, ActivityNotificationActivation, ActivityPushTarget
];

export {
    ActivityBoard, Activity, ActivityAssignment, ActivityChecklistItem, ActivityComment,
    ActivityHistory, ActivityAlert, ActivityDelivery, ActivityOperation, ActivityNotificationActivation, ActivityPushTarget
};

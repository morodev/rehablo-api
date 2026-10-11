import {createRequire} from 'node:module';
import {sequelize} from '../../../config/database.js';
const require = createRequire(import.meta.url);
const migration = require('../../../../migrations/20261011-activities-notifications-public.js');
export async function migrateActivityPublicNotifications(): Promise<void> {
    await migration.up(sequelize.getQueryInterface());
}

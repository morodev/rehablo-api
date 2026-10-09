import { createRequire } from 'node:module';
import { sequelize } from '../../../config/database.js';
const require = createRequire(import.meta.url);
const migration = require('../../../../migrations/20261009-structure-calendars.js');
/** Runs after owner-to-structure bootstrap and before serving any request. */
export async function migrateStructureCalendars(): Promise<void> {
    await migration.up(sequelize.getQueryInterface());
}

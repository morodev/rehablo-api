import {createRequire} from 'node:module';
import {sequelize} from '../../../config/database.js';
const require = createRequire(import.meta.url);
const migration = require('../../../../migrations/20261018-secretary-role-separation.js');
export async function migrateSecretaryRoles(): Promise<void> {
    await migration.up(sequelize.getQueryInterface());
}

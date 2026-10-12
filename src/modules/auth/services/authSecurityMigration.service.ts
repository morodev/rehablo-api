import { createRequire } from 'node:module';
import { sequelize } from '../../../config/database.js';
const require = createRequire(import.meta.url);
const migration = require('../../../../migrations/20261012-auth-security-public.js');

/** Migrazione pubblica additiva, prima che il servizio accetti richieste. */
export async function migrateAuthSecurity(): Promise<void> {
    await migration.up(sequelize.getQueryInterface());
}

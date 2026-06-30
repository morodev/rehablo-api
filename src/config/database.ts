import { Sequelize } from 'sequelize';
import { env } from './env.js';

/**
 * Single Postgres connection for the whole monolith.
 * - The "public" schema hosts global/shared data (tenants, users, structures, licenses...).
 * - Each tenant additionally gets a dynamic schema "rehablo_<tenantId>" that hosts
 *   tenant-scoped business data (patients, invoices, agenda events, products...),
 *   exactly like in the former microservices, but now sharing the same database.
 */
export const sequelize = new Sequelize(env.databaseUrl, {
    dialect: 'postgres',
    protocol: 'postgres',
    logging: env.isProduction ? false : console.log,
    dialectOptions: {
        ssl: env.dbSsl ? { require: true, rejectUnauthorized: false } : false
    }
});

export async function connectDatabase(): Promise<void> {
    await sequelize.authenticate();
    console.log('[database] connection established');
}


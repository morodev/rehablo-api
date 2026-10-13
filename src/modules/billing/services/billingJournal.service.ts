import { QueryTypes, Sequelize } from 'sequelize';
import { env } from '../../../config/env.js';

/**
 * Progress must commit even when the tenant transaction later rolls back. A dedicated
 * single-connection pool avoids starving Sequelize's main pool when concurrent tenant
 * transactions all wait to persist progress. This connection only updates existing
 * ledger rows; it never reads/locks tenants or billing accounts.
 */
const journalDatabase = new Sequelize(env.databaseUrl, {
    dialect: 'postgres',
    protocol: 'postgres',
    logging: false,
    dialectOptions: { ssl: env.dbSsl ? { require: true, rejectUnauthorized: false } : false },
    pool: { max: 1, min: 0, idle: 10000, acquire: 30000 }
});

export const billingJournal = {
    async saveProgress(operation: { id: string; tenantId: string; progress: Record<string, unknown> | null }): Promise<void> {
        // The enclosing tenant transaction must not lock or write this ledger row until
        // all journal calls finish. Its already-committed processing state reserves it.
        const [, affected] = await journalDatabase.query(
            'UPDATE "public"."billing_operations" SET "progress" = $1::jsonb, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $2 AND "tenantId" = $3 AND "state" = \'processing\'',
            { bind: [JSON.stringify(operation.progress), operation.id, operation.tenantId], type: QueryTypes.UPDATE }
        );
        if (affected !== 1) throw new Error('Impossibile salvare lo stato dell’operazione di pagamento. Riprova la stessa operazione.');
    }
};

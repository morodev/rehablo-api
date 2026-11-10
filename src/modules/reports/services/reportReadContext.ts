import type {Request} from 'express';
import {Sequelize, Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';

const reportTransaction = Symbol('reportReadTransaction');
export const liveReportReadsEnabled = () => process.env.REPORTS_LIVE_READS_ENABLED !== 'false';
export function getReportTransaction(req: Request): Transaction | undefined {
    return (req as Request & {[reportTransaction]?: Transaction})[reportTransaction];
}
/** The context and snapshot belong to one response; nothing is retained for the next read. */
export async function withReportReadSnapshot<T>(req: Request, read: (request: Request) => Promise<T>, database: Pick<Sequelize, 'transaction' | 'query'> = sequelize): Promise<T> {
    if (getReportTransaction(req)) return read(req);
    return database.transaction({isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ}, async transaction => {
        // Use the primary connection: Sequelize 6 readOnly selects replicas, not SQL access mode.
        await database.query('SET TRANSACTION READ ONLY', {transaction});
        const snapshotRequest = Object.assign(Object.create(req), {[reportTransaction]: transaction}) as Request;
        return read(snapshotRequest);
    });
}

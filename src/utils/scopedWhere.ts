import { Op, type WhereOptions } from 'sequelize';

/** A requested filter can narrow an authorization scope, never replace it. */
export function withScope(scope: WhereOptions, filters: WhereOptions): WhereOptions {
    return { [Op.and]: [scope, filters] };
}

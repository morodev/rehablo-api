import { col, fn, Op, where as sequelizeWhere } from 'sequelize';

/** Normalizes free-text search input consistently across API endpoints. */
export function normalizeSearchQuery(value: unknown): string {
    return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Escapes PostgreSQL LIKE wildcards so user input is always interpreted literally. */
export function escapeLikePattern(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export function searchTokens(value: unknown): string[] {
    const query = normalizeSearchQuery(value);
    return query ? query.split(' ').map(escapeLikePattern) : [];
}

export function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
}

/** Builds an AND-of-tokens / OR-of-fields condition for ordinary text columns. */
export function textSearchWhere(fields: string[], value: unknown): Record<string | symbol, unknown> | null {
    const tokens = searchTokens(value);
    if (!tokens.length) return null;
    return {
        [Op.and]: tokens.map((token) => ({
            [Op.or]: fields.map((field) => sequelizeWhere(fn('LOWER', col(field)), Op.like, `%${token}%`))
        }))
    };
}

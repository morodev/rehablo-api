import { NextFunction, Request, Response } from 'express';
import { sendErrorResponse } from '../utils/response.js';

interface Bucket {
    count: number;
    resetAt: number;
}
const buckets = new Map<string, Bucket>();

/** Rate limiter locale, sufficiente come seconda barriera oltre al reverse proxy. */
export function simpleRateLimit(options: { windowMs: number; max: number; namespace: string }) {
    return (req: Request, res: Response, next: NextFunction) => {
        const now = Date.now();
        const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
        const key = `${options.namespace}:${ip}`;
        let bucket = buckets.get(key);

        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + options.windowMs };
            buckets.set(key, bucket);
        }

        bucket.count += 1;
        if (bucket.count > options.max) {
            res.setHeader('Retry-After', Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)));
            return sendErrorResponse(res, 429, 'Troppi tentativi. Riprova più tardi.');
        }

        // Evita crescita illimitata senza introdurre timer che tengono vivo il processo.
        if (buckets.size > 10_000) {
            for (const [bucketKey, value] of buckets) {
                if (value.resetAt <= now) buckets.delete(bucketKey);
            }
        }
        return next();
    };
}

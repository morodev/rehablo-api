import { Request, Response, NextFunction } from 'express';

/** Tiny helper to avoid try/catch boilerplate in every async controller. */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
    return (req: Request, res: Response, next: NextFunction) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}


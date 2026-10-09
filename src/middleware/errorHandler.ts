import { NextFunction, Request, Response } from 'express';
import { sendErrorResponse } from '../utils/response.js';

export function notFoundHandler(req: Request, res: Response) {
    sendErrorResponse(res, 404, `Route not found: ${req.method} ${req.originalUrl}`);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
    if (err?.name === 'SequelizeUniqueConstraintError') {
        const fields = [...new Set<string>([
            ...Object.keys(err?.fields ?? {}),
            ...(Array.isArray(err?.errors)
                ? err.errors.map((item: any) => item?.path).filter((path: unknown): path is string => typeof path === 'string')
                : [])
        ])];
        console.warn('[errorHandler] unique constraint violation', {fields});
        return sendErrorResponse(res, 409, 'Dato già utilizzato.', {
            code: 'RESOURCE_ALREADY_EXISTS',
            fields
        });
    }

    console.error(err);

    if (err?.name === 'SequelizeValidationError') {
        return sendErrorResponse(res, 422, 'Validation error', err.errors);
    }

    // F0.1: errori di upload (multer), es. file troppo grande (`LIMIT_FILE_SIZE`).
    if (err?.name === 'MulterError') {
        const statusCode = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return sendErrorResponse(res, statusCode, `Upload error: ${err.message}`, err.code);
    }

    const statusCode = err?.statusCode || 500;
    sendErrorResponse(res, statusCode, err?.message || 'Internal server error');
}


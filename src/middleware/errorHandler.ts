import { NextFunction, Request, Response } from 'express';
import { sendErrorResponse } from '../utils/response.js';

export function notFoundHandler(req: Request, res: Response) {
    sendErrorResponse(res, 404, `Route not found: ${req.method} ${req.originalUrl}`);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
    console.error(err);

    if (err?.name === 'SequelizeUniqueConstraintError') {
        return sendErrorResponse(res, 409, 'Unique constraint violation', err.errors);
    }

    if (err?.name === 'SequelizeValidationError') {
        return sendErrorResponse(res, 422, 'Validation error', err.errors);
    }

    const statusCode = err?.statusCode || 500;
    sendErrorResponse(res, statusCode, err?.message || 'Internal server error');
}


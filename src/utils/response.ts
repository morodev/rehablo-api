import { Response } from 'express';

export function sendSuccessResponse(res: Response, statusCode: number, data: unknown, message = 'OK') {
    return res.status(statusCode).json({
        status: 'success',
        message,
        data
    });
}

export function sendErrorResponse(res: Response, statusCode: number, message: string, error?: unknown) {
    return res.status(statusCode).json({
        status: 'error',
        message,
        error
    });
}


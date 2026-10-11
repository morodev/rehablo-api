import type {Response} from 'express';
import {sendErrorResponse} from '../../../utils/response.js';

export type ActivityErrorCode =
    | 'ACTIVITY_VALIDATION_FAILED' | 'INVALID_ALERT' | 'INVALID_ASSIGNEE'
    | 'ACTIVITY_CONTEXT_REQUIRED' | 'ACTIVITY_FORBIDDEN' | 'ACTIVITY_NOT_FOUND'
    | 'ACTIVITY_BOARD_UNAVAILABLE' | 'ACTIVITY_CHANNEL_UNAVAILABLE'
    | 'ACTIVITY_VERSION_CONFLICT' | 'ORDER_CONFLICT' | 'CHECKLIST_VERSION_CONFLICT'
    | 'CHECKLIST_ITEM_VERSION_CONFLICT' | 'COMMENT_VERSION_CONFLICT'
    | 'CHECKLIST_INCOMPLETE' | 'OPERATION_ID_REUSED' | 'ACTIVITY_CURSOR_EXPIRED'
    | 'INVALID_TRANSITION' | 'OPEN_ACTIVITIES_REQUIRE_REASSIGNMENT';

export class ActivityError extends Error {
    readonly code: ActivityErrorCode;
    readonly statusCode: number;
    readonly fields?: Record<string, string>;

    constructor(code: ActivityErrorCode, statusCode: number, message: string, fields?: Record<string, string>) {
        super(message);
        this.name = 'ActivityError';
        this.code = code;
        this.statusCode = statusCode;
        this.fields = fields && Object.keys(fields).length ? fields : undefined;
    }
}

/** Keep domain codes in the existing response envelope, without exposing internal errors. */
export function sendActivityError(res: Response, error: ActivityError, requestId?: string) {
    return sendErrorResponse(res, error.statusCode, error.message, {
        code: error.code,
        ...(error.fields ? {fields: error.fields} : {}),
        ...(requestId ? {requestId} : {})
    });
}

export function activityValidationError(field: string, message: string, code: ActivityErrorCode = 'ACTIVITY_VALIDATION_FAILED'): never {
    throw new ActivityError(code, 422, message, {[field]: message});
}

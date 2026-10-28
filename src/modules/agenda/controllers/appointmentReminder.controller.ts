import {Request, Response} from 'express';
import {asyncHandler} from '../../../utils/asyncHandler.js';
import {sendSuccessResponse} from '../../../utils/response.js';
import {appointmentReminderSummaries, sendAppointmentReminderEmail,
    prepareAppointmentReminderWhatsApp, markAppointmentReminderWhatsAppOpened} from '../services/appointmentReminder.service.js';

export const getAppointmentReminderSummaries = asyncHandler(async (req: Request, res: Response) =>
    sendSuccessResponse(res, 200, await appointmentReminderSummaries(req)));
export const emailAppointmentReminder = asyncHandler(async (req: Request, res: Response) =>
    sendSuccessResponse(res, 200, await sendAppointmentReminderEmail(req)));
export const prepareWhatsAppAppointmentReminder = asyncHandler(async (req: Request, res: Response) =>
    sendSuccessResponse(res, 200, await prepareAppointmentReminderWhatsApp(req)));
export const openedWhatsAppAppointmentReminder = asyncHandler(async (req: Request, res: Response) =>
    sendSuccessResponse(res, 200, await markAppointmentReminderWhatsAppOpened(req)));

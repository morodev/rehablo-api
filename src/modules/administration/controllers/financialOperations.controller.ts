import {asyncHandler} from '../../../utils/asyncHandler.js';
import {sendSuccessResponse} from '../../../utils/response.js';
import {recordExpensePayment, voidExpensePayment, recordTransfer, voidTransfer} from '../services/financialOperations.service.js';
import {voidPatientAdvance, voidPatientRefund} from '../services/financialCreditReversal.service.js';

export const payExpense = asyncHandler(async (req, res) => sendSuccessResponse(res, 201, await recordExpensePayment(req), 'Pagamento spesa registrato'));
export const reverseExpensePayment = asyncHandler(async (req, res) => sendSuccessResponse(res, 200, await voidExpensePayment(req), 'Pagamento spesa annullato'));
export const createTransfer = asyncHandler(async (req, res) => sendSuccessResponse(res, 201, await recordTransfer(req), 'Trasferimento registrato'));
export const reverseTransfer = asyncHandler(async (req, res) => sendSuccessResponse(res, 200, await voidTransfer(req), 'Trasferimento annullato'));
export const reversePatientAdvance = asyncHandler(async (req, res) => sendSuccessResponse(res, 200, await voidPatientAdvance(req), 'Anticipo annullato'));
export const reversePatientRefund = asyncHandler(async (req, res) => sendSuccessResponse(res, 200, await voidPatientRefund(req), 'Rimborso annullato'));

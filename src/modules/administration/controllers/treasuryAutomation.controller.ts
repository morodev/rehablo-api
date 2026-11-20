import {asyncHandler} from '../../../utils/asyncHandler.js';
import {sendSuccessResponse} from '../../../utils/response.js';
import {applyTreasuryHistory, previewPaymentClassification, previewTreasuryHistory, readTreasuryDefaults, treasuryCategoryOptions, updateTreasuryDefaults} from '../services/treasuryAutomation.service.js';

export const categoryOptions=asyncHandler(async(req,res)=>sendSuccessResponse(res,200,await treasuryCategoryOptions(req,req.query.direction)));
export const paymentClassificationPreview=asyncHandler(async(req,res)=>sendSuccessResponse(res,200,await previewPaymentClassification(req)));
export const categoryDefaults=asyncHandler(async(req,res)=>sendSuccessResponse(res,200,await readTreasuryDefaults(req)));
export const saveCategoryDefaults=asyncHandler(async(req,res)=>sendSuccessResponse(res,200,await updateTreasuryDefaults(req)));
export const historyPreview=asyncHandler(async(req,res)=>sendSuccessResponse(res,200,await previewTreasuryHistory(req)));
export const historyApply=asyncHandler(async(req,res)=>sendSuccessResponse(res,200,await applyTreasuryHistory(req)));

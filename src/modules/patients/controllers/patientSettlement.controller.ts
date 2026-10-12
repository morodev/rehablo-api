import {asyncHandler} from '../../../utils/asyncHandler.js';
import {sendSuccessResponse} from '../../../utils/response.js';
import {patientSettlementPositionView, resolvePatientSettlementContext} from '../services/patientSettlementAccess.service.js';
import {executePatientSettlement} from '../services/patientSettlement.service.js';

export const getPatientSettlementPosition = asyncHandler(async (req, res) => {
    const context = await resolvePatientSettlementContext(req, req.query);
    return sendSuccessResponse(res, 200, await patientSettlementPositionView(req, context), 'Situazione economica caricata');
});
export const createPatientSettlement = asyncHandler(async (req, res) => {
    const result = await executePatientSettlement(req);
    return sendSuccessResponse(res, result.replayed ? 200 : 201, result,
        result.replayed ? 'Registrazione già completata' : 'Saldo registrato');
});

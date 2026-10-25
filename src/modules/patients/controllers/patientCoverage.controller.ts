import {asyncHandler} from '../../../utils/asyncHandler.js';
import {sendSuccessResponse} from '../../../utils/response.js';
import {patientCoveragePosition, resolvePatientCoverageContext} from '../services/patientCoverage.service.js';

export const getPatientCoveragePosition = asyncHandler(async (req, res) => {
    const context = await resolvePatientCoverageContext(req);
    return sendSuccessResponse(res, 200, await patientCoveragePosition(req, context), 'Pacchetti e crediti caricati');
});

import {asyncHandler} from '../../../utils/asyncHandler.js';
import {sendSuccessResponse} from '../../../utils/response.js';
import {getPatientContactFollowUp, setPatientContactFollowUp} from '../services/patientContactFollowUp.service.js';
export const getContactFollowUp = asyncHandler(async (req, res) => sendSuccessResponse(res, 200, await getPatientContactFollowUp(req), 'Preferenza recapiti caricata'));
export const setContactFollowUp = asyncHandler(async (req, res) => sendSuccessResponse(res, 200, await setPatientContactFollowUp(req), 'Preferenza recapiti salvata'));

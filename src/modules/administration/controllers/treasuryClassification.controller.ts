import {Op} from 'sequelize';
import {asyncHandler} from '../../../utils/asyncHandler.js';
import {sendSuccessResponse} from '../../../utils/response.js';
import {resolveReportScope} from '../../reports/services/reportScope.service.js';
import {readCategoryAnalysis, readTaxonomy, saveClassification, saveTaxonomy, treasuryClassificationScope} from '../services/treasuryClassification.service.js';

export const getTreasuryTaxonomy = asyncHandler(async (req, res) => sendSuccessResponse(res, 200, await readTaxonomy(req)));
export const saveTreasuryCategory = asyncHandler(async (req, res) => sendSuccessResponse(res, req.params.id ? 200 : 201, await saveTaxonomy(req, true)));
export const saveTreasuryTag = asyncHandler(async (req, res) => sendSuccessResponse(res, req.params.id ? 200 : 201, await saveTaxonomy(req, false)));
export const classifyTreasuryMovement = asyncHandler(async (req, res) => sendSuccessResponse(res, 200, await saveClassification(req)));
export const getTreasuryCategoryAnalysis = asyncHandler(async (req, res) => {
    const [analytics, treasury] = await Promise.all([
        resolveReportScope(req, {resource: 'analytics', action: 'read'}),
        resolveReportScope(req, {resource: 'treasury', action: 'read'})
    ]);
    const ids = analytics.selectedStructureIds.filter(id => treasury.selectedStructureIds.includes(id));
    const scope = {[Op.and]: [{structureId: {[Op.in]: ids}}, treasuryClassificationScope(req)]};
    return sendSuccessResponse(res, 200, await readCategoryAnalysis(req, scope));
});

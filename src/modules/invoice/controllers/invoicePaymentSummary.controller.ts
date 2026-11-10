import {Request, Response} from 'express';
import {Op, Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {asyncHandler} from '../../../utils/asyncHandler.js';
import {sendErrorResponse, sendSuccessResponse} from '../../../utils/response.js';
import {patientScopeWhere} from '../../../middleware/rbac.js';
import Invoice from '../models/invoice.model.js';
import {getPaymentSummaries} from '../services/payment.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const invoicePaymentSummaries = asyncHandler(async (req: Request, res: Response) => {
    const input = typeof req.query.ids === 'string' ? req.query.ids.split(',').map(id => id.trim()) : [];
    if (!input.length || input.length > 100 || input.some(id => !UUID.test(id))) {
        return sendErrorResponse(res, 400, 'Specificare da 1 a 100 identificativi di fattura validi');
    }
    const schema = req.tenantSchema!;
    const items = await sequelize.transaction({isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ}, async transaction => {
        // Sequelize readOnly routes to a replica; explicitly constrain the primary snapshot instead.
        await sequelize.query('SET TRANSACTION READ ONLY', {transaction});
        const rows = await Invoice.schema(schema).findAll({
            where: {[Op.and]: [{id: {[Op.in]: [...new Set(input)]}}, patientScopeWhere(req, schema, 'patientID')]},
            transaction, attributes: ['id', 'invoiceTotal', 'invoiceNet', 'status', 'documentType']
        });
        const invoices = rows.map(row => row.get({plain: true}) as Record<string, any>);
        const summaries = await getPaymentSummaries(schema, invoices, transaction);
        return invoices.map(invoice => {
            const summary = summaries.get(invoice.id)!;
            return {id: invoice.id, invoiceTotal: invoice.invoiceTotal,
                balance: summary.balance, paidAmount: summary.paidAmount, paymentStatus: summary.paymentStatus};
        });
    });
    return sendSuccessResponse(res, 200, {items}, 'Invoice payment summaries loaded');
});

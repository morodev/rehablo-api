import { Request, Response } from 'express';
import { Op, fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import Invoice from '../models/invoice.model.js';
import InvoiceProduct from '../models/invoiceProduct.model.js';
import InvoiceService from '../models/invoiceService.model.js';
import Product from '../../products-services/models/product.model.js';
import Service from '../../products-services/models/service.model.js';
import { evalTotals } from '../utils/evalTotals.js';

/**
 * Builds tenant-scoped model variants and (re)declares the M2M associations on them.
 * Sequelize associations are normally declared once at boot, but since every tenant has its
 * own dynamic Postgres schema, we must re-bind them per schema, exactly like the legacy code did.
 */
function getScopedModels(schema: string) {
    const InvoiceScoped = Invoice.schema(schema);
    const ProductScoped = Product.schema(schema);
    const ServiceScoped = Service.schema(schema);
    const InvoiceProductScoped = InvoiceProduct.schema(schema);
    const InvoiceServiceScoped = InvoiceService.schema(schema);

    InvoiceScoped.belongsToMany(ProductScoped, {
        through: InvoiceProductScoped,
        foreignKey: 'InvoiceId',
        otherKey: 'ProductId'
    });
    ProductScoped.belongsToMany(InvoiceScoped, {
        through: InvoiceProductScoped,
        foreignKey: 'ProductId',
        otherKey: 'InvoiceId'
    });

    InvoiceScoped.belongsToMany(ServiceScoped, {
        through: InvoiceServiceScoped,
        foreignKey: 'InvoiceId',
        otherKey: 'ServiceId'
    });
    ServiceScoped.belongsToMany(InvoiceScoped, {
        through: InvoiceServiceScoped,
        foreignKey: 'ServiceId',
        otherKey: 'InvoiceId'
    });

    return { InvoiceScoped, ProductScoped, ServiceScoped, InvoiceProductScoped, InvoiceServiceScoped };
}

export const saveInvoice = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped, InvoiceProductScoped, InvoiceServiceScoped } = getScopedModels(schema);

    const { products = [], services = [], ...invoiceFields } = req.body;

    const totals = evalTotals({ ...invoiceFields, products });

    const invoice = await InvoiceScoped.create({ ...invoiceFields, ...totals });

    await Promise.all([
        ...products.map((product: any) =>
            InvoiceProductScoped.create({
                InvoiceId: invoice.get('id') as string,
                ProductId: product.id,
                quantity: product.quantity ?? 1,
                productPrice: product.sellingPrice,
                totalPrice: product.sellingPrice * (product.quantity ?? 1),
                percentageDiscount: product.percentageDiscount,
                discountAmount: product.discountAmount
            })
        ),
        ...services.map((service: any) =>
            InvoiceServiceScoped.create({
                InvoiceId: invoice.get('id') as string,
                ServiceId: service.id,
                quantity: service.quantity ?? 1,
                servicePrice: service.sellingPrice,
                totalPrice: service.sellingPrice * (service.quantity ?? 1),
                percentageDiscount: service.percentageDiscount,
                discountAmount: service.discountAmount
            })
        )
    ]);

    return sendSuccessResponse(res, 201, invoice, 'Invoice Created');
});

export const findAllInvoices = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped, ProductScoped, ServiceScoped } = getScopedModels(schema);

    const page = parseInt((req.query.page as string) ?? '1', 10);
    const size = parseInt((req.query.size as string) ?? '10', 10);

    const { count, rows } = await InvoiceScoped.findAndCountAll({
        include: [{ model: ProductScoped }, { model: ServiceScoped }],
        limit: size,
        offset: (page - 1) * size,
        distinct: true
    });

    return sendSuccessResponse(
        res,
        200,
        {
            pagination: { length: count, size, page, lastPage: Math.max(Math.ceil(count / size), 1) },
            invoices: rows
        },
        'Fatture caricate correttamente'
    );
});

export const searchInvoices = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped } = getScopedModels(schema);
    const query = (req.query.query as string) || '';

    const invoices = await InvoiceScoped.findAll({
        where: {
            [Op.or]: [
                sequelizeWhere(fn('LOWER', col('status')), 'LIKE', `%${query.toLowerCase()}%`),
                sequelizeWhere(fn('LOWER', col('paymentMethod')), 'LIKE', `%${query.toLowerCase()}%`)
            ]
        }
    });

    return sendSuccessResponse(res, 200, invoices, 'Ricerca completata');
});

export const findOneInvoice = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped, ProductScoped, ServiceScoped } = getScopedModels(schema);

    const invoice = await InvoiceScoped.findByPk(req.params.invoiceId, {
        include: [{ model: ProductScoped }, { model: ServiceScoped }]
    });

    if (!invoice) {
        return sendErrorResponse(res, 404, 'Fattura non trovata');
    }

    return sendSuccessResponse(res, 200, { invoice }, 'Fattura caricata correttamente');
});

export const updateInvoice = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped } = getScopedModels(schema);
    const id = req.params.invoiceId;

    const [rowsUpdated] = await InvoiceScoped.update(req.body.invoice ?? req.body, { where: { id } });
    if (rowsUpdated === 0) {
        return sendErrorResponse(res, 404, 'Impossibile aggiornare la fattura');
    }

    const updatedInvoice = await InvoiceScoped.findByPk(id);
    return sendSuccessResponse(res, 200, updatedInvoice, 'Fattura aggiornata correttamente');
});

export const deleteInvoice = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped } = getScopedModels(schema);
    const id = req.params.invoiceId;

    const removedInvoice = await InvoiceScoped.findByPk(id);
    await InvoiceScoped.destroy({ where: { id } });

    return sendSuccessResponse(res, 200, { removedInvoice }, 'Fattura eliminata correttamente');
});

export default { saveInvoice, findAllInvoices, searchInvoices, findOneInvoice, updateInvoice, deleteInvoice };


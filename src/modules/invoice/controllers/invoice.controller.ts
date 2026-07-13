import { Request, Response } from 'express';
import { Op, fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { sequelize } from '../../../config/database.js';
import Invoice from '../models/invoice.model.js';
import InvoiceProduct from '../models/invoiceProduct.model.js';
import InvoiceService from '../models/invoiceService.model.js';
import Product from '../../products-services/models/product.model.js';
import Service from '../../products-services/models/service.model.js';
import Patient from '../../patients/models/patient.model.js';
import Tenant from '../../auth/models/tenant.model.js';
import { evalTotals } from '../utils/evalTotals.js';
import { buildSistemaTSRecord, generateSistemaTSXml, SistemaTSRecord } from '../utils/sistemaTS.js';

/**
 * NOTA SULL'INTEGRITÀ REFERENZIALE: in questa architettura multi-tenant, `Invoice`/`InvoiceProduct`/
 * `InvoiceService`/`Product`/`Service` vivono in uno schema Postgres dinamico per-tenant, sincronizzato
 * via `.schema(schema).sync({ alter: true })` in `ensureTenantSchema()`. Le associazioni tra questi
 * modelli sono dichiarate UNA SOLA VOLTA a boot in `../models/index.ts` (vedi `getScopedModels` sotto),
 * non a livello di `sync`: di conseguenza NON esistono vincoli FK reali a livello database su queste
 * tabelle. L'integrità referenziale (id prodotto/servizio esistente, pulizia righe orfane alla
 * cancellazione, ecc.) è garantita qui a livello applicativo (vedi `resolveCatalogLines`, `deleteInvoice`).
 */

/**
 * Builds tenant-scoped model variants for querying (`.schema(schema)` on each model).
 *
 * NOTA: le associazioni Invoice -> InvoiceProduct/InvoiceService NON vengono (ri)dichiarate qui:
 * sono registrate UNA SOLA VOLTA a boot in `../models/index.ts` (`registerInvoiceAssociations`,
 * chiamata da `registerTenantModels()`), esattamente come per gli altri moduli tenant-scoped
 * (vedi `registerEvaluationAssociations`, `registerProductsServicesAssociations`). Ridichiarare
 * l'associazione ad ogni richiesta (come faceva questa funzione in precedenza) causa l'errore
 * Sequelize "You have used the alias X in two separate associations..." dalla seconda richiesta
 * in poi, perché `Model.schema()` crea un clone che eredita (senza copiarla) la stessa mappa
 * `associations` del modello base, condivisa da tutte le richieste/tenant nel processo.
 *
 * L'associazione è `hasMany` verso `InvoiceProduct`/`InvoiceService` (non `belongsToMany` verso il
 * catalogo Product/Service): il frontend si aspetta che `invoice.products`/`invoice.services` siano
 * DIRETTAMENTE le righe snapshot della tabella ponte (`ProductId`/`ServiceId`, `productName`/
 * `serviceName`, `productPrice`/`servicePrice`, `productVat`/`serviceVat`, `quantity`, ecc.).
 */
function getScopedModels(schema: string) {
    const InvoiceScoped = Invoice.schema(schema);
    const ProductScoped = Product.schema(schema);
    const ServiceScoped = Service.schema(schema);
    const InvoiceProductScoped = InvoiceProduct.schema(schema);
    const InvoiceServiceScoped = InvoiceService.schema(schema);


    return { InvoiceScoped, ProductScoped, ServiceScoped, InvoiceProductScoped, InvoiceServiceScoped };
}

interface ResolvedInvoiceLine {
    id: string;
    quantity: number;
    unitPrice: number;
    /** Aliquota/natura IVA presa dal catalogo (es. "22", "N4"), mai dal client. */
    vat: string | null;
    name: string | null;
    percentageDiscount: number | null;
    discountAmount: number | null;
}

/**
 * Risolve le righe di una fattura (prodotti o servizi) contro il CATALOGO reale lato server.
 *
 * Prezzo e aliquota IVA vengono SEMPRE presi da `Product`/`Service` in database, MAI da quanto
 * eventualmente inviato dal client: fidarsi del body per questi valori permetterebbe a un client
 * malevolo (o a un bug del frontend) di alterare l'importo o l'aliquota IVA di un documento
 * fiscale. Dal client si accettano solo `id`, `quantity` ed eventuali sconti di riga.
 *
 * Restituisce `missingId` (invece di lanciare) se uno degli id richiesti non esiste nel
 * catalogo del tenant, così il chiamante può rispondere con un 400 controllato.
 */
async function resolveCatalogLines(
    requestedLines: Array<{ id?: string; quantity?: number; percentageDiscount?: number; discountAmount?: number }>,
    catalogModel: { findAll: (options: any) => Promise<any[]> }
): Promise<{ lines: ResolvedInvoiceLine[]; missingId?: string }> {
    const ids = requestedLines.map((l) => l?.id).filter(Boolean);
    const catalogRows = ids.length ? await catalogModel.findAll({ where: { id: ids } }) : [];
    const byId = new Map(catalogRows.map((row) => [row.get('id') as string, row]));

    const missing = requestedLines.find((l) => !l?.id || !byId.has(l.id));
    if (missing) {
        return { lines: [], missingId: missing?.id ?? '(id mancante)' };
    }

    const lines = requestedLines.map((requested) => {
        const catalog = byId.get(requested.id as string)!;
        return {
            id: requested.id as string,
            quantity: requested.quantity ?? 1,
            unitPrice: Number(catalog.get('sellingPrice')) || 0,
            vat: (catalog.get('productVat') as string | null) ?? null,
            name: (catalog.get('name') as string | null) ?? null,
            percentageDiscount: requested.percentageDiscount ?? null,
            discountAmount: requested.discountAmount ?? null
        };
    });

    return { lines };
}

const toEvalLine = (line: ResolvedInvoiceLine) => ({
    sellingPrice: line.unitPrice,
    quantity: line.quantity,
    productVat: line.vat
});

export const saveInvoice = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped, ProductScoped, ServiceScoped, InvoiceProductScoped, InvoiceServiceScoped } =
        getScopedModels(schema);

    const { products: requestedProducts = [], services: requestedServices = [], ...invoiceFields } = req.body;

    const [{ lines: productLines, missingId: missingProductId }, { lines: serviceLines, missingId: missingServiceId }] =
        await Promise.all([
            resolveCatalogLines(requestedProducts, ProductScoped),
            resolveCatalogLines(requestedServices, ServiceScoped)
        ]);

    if (missingProductId) {
        return sendErrorResponse(res, 400, `Prodotto non trovato nel catalogo: ${missingProductId}`);
    }
    if (missingServiceId) {
        return sendErrorResponse(res, 400, `Servizio non trovato nel catalogo: ${missingServiceId}`);
    }

    const totals = evalTotals({
        products: productLines.map(toEvalLine),
        services: serviceLines.map(toEvalLine),
        discountType: invoiceFields.discountType,
        discountAmount: invoiceFields.discountAmount,
        isRivals: invoiceFields.isRivals,
        rivals: invoiceFields.rivals,
        isCashPro: invoiceFields.isCashPro,
        isTaxWithholding: invoiceFields.isTaxWithholding,
        taxWithholding: invoiceFields.taxWithholding
    });

    // --- Adempimenti fiscali: numerazione progressiva senza "buchi" per anno fiscale, e
    // verifica automatica dell'eventuale opposizione del paziente all'invio Sistema TS. ---
    const tenantId = req.user!.tenants[0].id;
    const fiscalYear =
        invoiceFields.documentYear ?? new Date(invoiceFields.emissionDate ?? Date.now()).getFullYear();

    let stsExcluded = Boolean(invoiceFields.stsExcluded);
    if (invoiceFields.patientID) {
        const patient = await Patient.schema(schema).findByPk(invoiceFields.patientID);
        if (patient?.get('stsOppositionToDataSending')) {
            stsExcluded = true;
        }
    }

    // Numerazione progressiva + creazione fattura + creazione righe in un'UNICA transazione:
    // se una qualsiasi parte fallisce, non deve restare un numero "bruciato" senza fattura, né
    // una fattura senza le sue righe.
    const invoice = await sequelize.transaction(async (t) => {
        const tenant = await Tenant.findByPk(tenantId, { transaction: t, lock: t.LOCK.UPDATE });
        if (!tenant) {
            throw new Error('Tenant non trovato: impossibile assegnare il numero progressivo del documento');
        }
        const counters: Record<string, number> = {
            ...(tenant.get('lastDocumentNumberByYear') as Record<string, number>)
        };
        const nextNumber = (counters[fiscalYear] || 0) + 1;
        counters[fiscalYear] = nextNumber;
        await tenant.update({ lastDocumentNumberByYear: counters }, { transaction: t });

        const createdInvoice = await InvoiceScoped.create(
            { ...invoiceFields, ...totals, documentNumber: nextNumber, documentYear: fiscalYear, stsExcluded },
            { transaction: t }
        );
        const invoiceId = createdInvoice.get('id') as string;

        await Promise.all([
            ...productLines.map((line) =>
                InvoiceProductScoped.create(
                    {
                        InvoiceId: invoiceId,
                        ProductId: line.id,
                        quantity: line.quantity,
                        productPrice: line.unitPrice,
                        totalPrice: line.unitPrice * line.quantity,
                        percentageDiscount: line.percentageDiscount,
                        discountAmount: line.discountAmount,
                        productName: line.name,
                        productVat: line.vat
                    },
                    { transaction: t }
                )
            ),
            ...serviceLines.map((line) =>
                InvoiceServiceScoped.create(
                    {
                        InvoiceId: invoiceId,
                        ServiceId: line.id,
                        quantity: line.quantity,
                        servicePrice: line.unitPrice,
                        totalPrice: line.unitPrice * line.quantity,
                        percentageDiscount: line.percentageDiscount,
                        discountAmount: line.discountAmount,
                        serviceName: line.name,
                        serviceVat: line.vat
                    },
                    { transaction: t }
                )
            )
        ]);

        return createdInvoice;
    });

    const invoiceWithLines = await InvoiceScoped.findByPk(invoice.get('id') as string, {
        include: [
            { model: InvoiceProductScoped, as: 'products' },
            { model: InvoiceServiceScoped, as: 'services' }
        ]
    });

    return sendSuccessResponse(res, 201, invoiceWithLines, 'Invoice Created');
});

export const findAllInvoices = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped, InvoiceProductScoped, InvoiceServiceScoped } = getScopedModels(schema);

    const page = parseInt((req.query.page as string) ?? '1', 10);
    const size = parseInt((req.query.size as string) ?? '10', 10);

    const { count, rows } = await InvoiceScoped.findAndCountAll({
        include: [
            { model: InvoiceProductScoped, as: 'products' },
            { model: InvoiceServiceScoped, as: 'services' }
        ],
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
    const { InvoiceScoped, InvoiceProductScoped, InvoiceServiceScoped } = getScopedModels(schema);

    const invoice = await InvoiceScoped.findByPk(req.params.invoiceId, {
        include: [
            { model: InvoiceProductScoped, as: 'products' },
            { model: InvoiceServiceScoped, as: 'services' }
        ]
    });

    if (!invoice) {
        return sendErrorResponse(res, 404, 'Fattura non trovata');
    }

    return sendSuccessResponse(res, 200, { invoice }, 'Fattura caricata correttamente');
});

/**
 * Aggiorna una fattura. Se il body include `products`/`services` (anche array vuoto), le righe
 * vengono RIMPIAZZATE interamente e i totali fiscali ricalcolati (stessa logica/validazione di
 * `saveInvoice`, con prezzo/IVA sempre dal catalogo). Se non presenti, aggiorna solo i campi
 * scalari della fattura senza toccare le righe esistenti.
 */
export const updateInvoice = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped, ProductScoped, ServiceScoped, InvoiceProductScoped, InvoiceServiceScoped } =
        getScopedModels(schema);
    const id = req.params.invoiceId;

    const existingInvoice = await InvoiceScoped.findByPk(id);
    if (!existingInvoice) {
        return sendErrorResponse(res, 404, 'Fattura non trovata');
    }

    const body = req.body.invoice ?? req.body;
    const { products: requestedProducts, services: requestedServices, ...invoiceFields } = body;
    const shouldReplaceLines = Array.isArray(requestedProducts) || Array.isArray(requestedServices);

    let updateData: Record<string, unknown> = { ...invoiceFields };

    if (shouldReplaceLines) {
        const [
            { lines: productLines, missingId: missingProductId },
            { lines: serviceLines, missingId: missingServiceId }
        ] = await Promise.all([
            resolveCatalogLines(requestedProducts ?? [], ProductScoped),
            resolveCatalogLines(requestedServices ?? [], ServiceScoped)
        ]);

        if (missingProductId) {
            return sendErrorResponse(res, 400, `Prodotto non trovato nel catalogo: ${missingProductId}`);
        }
        if (missingServiceId) {
            return sendErrorResponse(res, 400, `Servizio non trovato nel catalogo: ${missingServiceId}`);
        }

        const totals = evalTotals({
            products: productLines.map(toEvalLine),
            services: serviceLines.map(toEvalLine),
            discountType: invoiceFields.discountType ?? existingInvoice.get('discountType'),
            discountAmount: invoiceFields.discountAmount ?? existingInvoice.get('discountAmount'),
            isRivals: invoiceFields.isRivals ?? existingInvoice.get('isRivals'),
            rivals: invoiceFields.rivals ?? existingInvoice.get('rivals'),
            isCashPro: invoiceFields.isCashPro ?? existingInvoice.get('isCashPro'),
            isTaxWithholding: invoiceFields.isTaxWithholding ?? existingInvoice.get('isTaxWithholding'),
            taxWithholding: invoiceFields.taxWithholding ?? existingInvoice.get('taxWithholding')
        });

        updateData = { ...updateData, ...totals };

        await sequelize.transaction(async (t) => {
            await InvoiceScoped.update(updateData, { where: { id }, transaction: t });
            await InvoiceProductScoped.destroy({ where: { InvoiceId: id }, transaction: t });
            await InvoiceServiceScoped.destroy({ where: { InvoiceId: id }, transaction: t });

            await Promise.all([
                ...productLines.map((line) =>
                    InvoiceProductScoped.create(
                        {
                            InvoiceId: id,
                            ProductId: line.id,
                            quantity: line.quantity,
                            productPrice: line.unitPrice,
                            totalPrice: line.unitPrice * line.quantity,
                            percentageDiscount: line.percentageDiscount,
                            discountAmount: line.discountAmount,
                            productName: line.name,
                            productVat: line.vat
                        },
                        { transaction: t }
                    )
                ),
                ...serviceLines.map((line) =>
                    InvoiceServiceScoped.create(
                        {
                            InvoiceId: id,
                            ServiceId: line.id,
                            quantity: line.quantity,
                            servicePrice: line.unitPrice,
                            totalPrice: line.unitPrice * line.quantity,
                            percentageDiscount: line.percentageDiscount,
                            discountAmount: line.discountAmount,
                            serviceName: line.name,
                            serviceVat: line.vat
                        },
                        { transaction: t }
                    )
                )
            ]);
        });
    } else {
        const [rowsUpdated] = await InvoiceScoped.update(updateData, { where: { id } });
        if (rowsUpdated === 0) {
            return sendErrorResponse(res, 404, 'Impossibile aggiornare la fattura');
        }
    }

    const updatedInvoice = await InvoiceScoped.findByPk(id, {
        include: [
            { model: InvoiceProductScoped, as: 'products' },
            { model: InvoiceServiceScoped, as: 'services' }
        ]
    });
    return sendSuccessResponse(res, 200, updatedInvoice, 'Fattura aggiornata correttamente');
});

/**
 * Elimina una fattura e le sue righe collegate. In questa architettura multi-schema dinamica
 * non esistono vincoli FK/cascade a livello DB (vedi nota in cima al file): la pulizia delle
 * righe `invoice_products`/`invoice_services` va quindi fatta esplicitamente qui per evitare
 * righe orfane.
 */
export const deleteInvoice = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped, InvoiceProductScoped, InvoiceServiceScoped } = getScopedModels(schema);
    const id = req.params.invoiceId;

    const removedInvoice = await InvoiceScoped.findByPk(id);
    if (!removedInvoice) {
        return sendErrorResponse(res, 404, 'Fattura non trovata');
    }

    await Promise.all([
        InvoiceProductScoped.destroy({ where: { InvoiceId: id } }),
        InvoiceServiceScoped.destroy({ where: { InvoiceId: id } })
    ]);
    await InvoiceScoped.destroy({ where: { id } });

    return sendSuccessResponse(res, 200, { removedInvoice }, 'Fattura eliminata correttamente');
});

/**
 * Genera il file XML di export per il Sistema Tessera Sanitaria (spese sanitarie detraibili),
 * relativo ai documenti dell'anno fiscale richiesto non ancora inviati e non esclusi
 * (per opposizione del paziente ex D.Lgs. 175/2014).
 *
 * NOTA BENE: l'export prodotto va validato con l'ultimo tracciato ufficiale prima della
 * trasmissione reale al Sistema TS (vedi commenti in `utils/sistemaTS.ts`).
 */
export const exportSistemaTS = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped } = getScopedModels(schema);
    const year = parseInt((req.query.year as string) ?? `${new Date().getFullYear()}`, 10);
    const markAsSent = req.query.markAsSent === 'true';
    const tenantId = req.user!.tenants[0].id;

    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) {
        return sendErrorResponse(res, 404, 'Struttura/tenant non trovato');
    }

    const invoices = await InvoiceScoped.findAll({
        where: { documentYear: year, stsExcluded: false, stsSent: false }
    });

    const records: SistemaTSRecord[] = [];
    const includedInvoiceIds: string[] = [];

    for (const invoice of invoices) {
        const patientID = invoice.get('patientID') as string | null;
        if (!patientID) continue;

        const patient = await Patient.schema(schema).findByPk(patientID);
        if (!patient || !patient.get('fiscalCode')) continue;

        try {
            records.push(
                buildSistemaTSRecord({
                    invoice: invoice.get({ plain: true }) as any,
                    patient: patient.get({ plain: true }) as any,
                    tenant: tenant.get({ plain: true }) as any
                })
            );
            includedInvoiceIds.push(invoice.get('id') as string);
        } catch (err) {
            console.warn(`[sistemaTS] fattura ${invoice.get('id')} esclusa dall'export:`, (err as Error).message);
        }
    }

    const xml = generateSistemaTSXml(records, year);

    if (markAsSent && includedInvoiceIds.length > 0) {
        await InvoiceScoped.update(
            { stsSent: true, stsSentAt: new Date() },
            { where: { id: { [Op.in]: includedInvoiceIds } } }
        );
    }

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sistema-ts-${year}.xml"`);
    return res.status(200).send(xml);
});

export default {
    saveInvoice,
    findAllInvoices,
    searchInvoices,
    findOneInvoice,
    updateInvoice,
    deleteInvoice,
    exportSistemaTS
};


import { Request, Response } from 'express';
import { Op, fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { patientScopeWhere } from '../../../middleware/rbac.js';
import { sequelize } from '../../../config/database.js';
import Invoice, { InvoiceRecipientSnapshot } from '../models/invoice.model.js';
import InvoiceProduct from '../models/invoiceProduct.model.js';
import InvoiceService from '../models/invoiceService.model.js';
import Product from '../../products-services/models/product.model.js';
import Service from '../../products-services/models/service.model.js';
import Patient from '../../patients/models/patient.model.js';
import Tenant from '../../auth/models/tenant.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import { evalTotals, EvalTotalsResult, toPersistedTotals } from '../utils/evalTotals.js';
import { buildIssuerSnapshot, getMissingIssuerFields } from '../utils/issuer.js';
import { buildFiscalNotes, FiscalProfile, isStampDutyDue, resolveFiscalProfile } from '../utils/fiscalRegime.js';
import { buildSistemaTSRecord, generateSistemaTSXml, SistemaTSRecord } from '../utils/sistemaTS.js';
import { recordAuditEvent } from '../../compliance/audit/audit.service.js';

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

/** Esito dell'applicazione del regime fiscale al documento in corso di emissione. */
interface FiscalOutcome {
    /** Campi fiscali normalizzati da persistere (sovrascrivono quanto arrivato dal client). */
    fields: {
        vatNature: string;
        isTaxWithholding: boolean;
        taxWithholding: number | null;
        isStamp: boolean;
        stampAmount: number | null;
        stampChargedToPatient: boolean;
    };
    totals: EvalTotalsResult;
    fiscalNotes: string[];
}

/**
 * Applica il REGIME FISCALE dello studio al documento e ricalcola i totali di conseguenza.
 *
 * Il controllo sta qui e non (solo) nella UI perché è una regola di validità del documento: un
 * forfettario che riuscisse a emettere una fattura con IVA e ritenuta produrrebbe un documento
 * fiscalmente errato, già numerato e quindi non eliminabile senza lasciare buchi nella numerazione.
 *
 * La marca da bollo richiede due passate: la soglia di 77,47 € si valuta sull'imponibile delle
 * sole righe SENZA IVA, che è a sua volta un risultato del calcolo. Si calcola quindi una prima
 * volta senza bollo per conoscere quella quota, poi si ricalcola includendolo se dovuto.
 */
function applyFiscalRules(params: {
    profile: FiscalProfile;
    invoiceFields: Record<string, any>;
    evalLines: { products: ReturnType<typeof toEvalLine>[]; services: ReturnType<typeof toEvalLine>[] };
}): FiscalOutcome {
    const { profile, invoiceFields, evalLines } = params;

    // Il regime può imporre la natura IVA (forfettario: N2.2 "non soggetta", che assorbe anche
    // l'esenzione sanitaria art. 10 n. 18 e quindi NON va indicata come N4).
    const vatNature = profile.forcedVatNature ?? invoiceFields.vatNature ?? profile.defaultVatNature;

    // Regimi forfettario/minimi: il committente non opera alcuna ritenuta (art. 1 c. 67 L. 190/2014).
    const isTaxWithholding = profile.allowsWithholding && Boolean(invoiceFields.isTaxWithholding);
    const taxWithholding = isTaxWithholding
        ? Number(invoiceFields.taxWithholding ?? profile.withholdingRate)
        : null;

    const baseInput = {
        products: evalLines.products,
        services: evalLines.services,
        discountType: invoiceFields.discountType,
        discountAmount: invoiceFields.discountAmount,
        isRivals: invoiceFields.isRivals,
        rivals: invoiceFields.rivals,
        isCashPro: invoiceFields.isCashPro,
        isTaxWithholding,
        taxWithholding: taxWithholding ?? 0,
        appliesVat: profile.appliesVat
    };

    const stampDue = isStampDutyDue(evalTotals(baseInput).vatFreeAmount, profile);

    // Se il client si esprime esplicitamente sul bollo la sua scelta viene rispettata (esistono
    // casi limite legittimi); se tace, si applica la regola di legge.
    const isStamp = invoiceFields.isStamp === undefined ? stampDue : Boolean(invoiceFields.isStamp);
    const stampAmount = isStamp ? Number(invoiceFields.stampAmount ?? profile.stampDutyAmount) : null;
    const stampChargedToPatient =
        invoiceFields.stampChargedToPatient === undefined
            ? profile.stampChargedToPatient
            : Boolean(invoiceFields.stampChargedToPatient);

    const totals = evalTotals({
        ...baseInput,
        isStamp,
        stampAmount: stampAmount ?? 0,
        stampChargedToPatient
    });

    return {
        fields: { vatNature, isTaxWithholding, taxWithholding, isStamp, stampAmount, stampChargedToPatient },
        totals,
        fiscalNotes: buildFiscalNotes({
            profile,
            hasVatFreeLines: totals.vatFreeAmount > 0,
            hasStampDuty: isStamp
        })
    };
}

const INVOICE_STATUS = {
    DRAFT: 'draft',
    ISSUED: 'issued',
    PAID: 'paid',
    VOID: 'void',
    CREDITED: 'credited'
} as const;

const IMMUTABLE_STATUSES = new Set<string>([
    INVOICE_STATUS.ISSUED,
    INVOICE_STATUS.PAID,
    INVOICE_STATUS.VOID,
    INVOICE_STATUS.CREDITED
]);

const PAYMENT_UPDATE_FIELDS = new Set(['status', 'paymentMethod', 'paymentTerms']);

function normalizeStatus(value: unknown): string {
    const status = `${value ?? ''}`.trim().toLowerCase();
    return status || INVOICE_STATUS.ISSUED;
}

function getInvoiceStatus(invoice: Invoice): string {
    const status = normalizeStatus(invoice.get('status'));
    if (status === INVOICE_STATUS.ISSUED && !invoice.get('documentNumber')) {
        return INVOICE_STATUS.DRAFT;
    }
    return status;
}

function isImmutableInvoice(invoice: Invoice): boolean {
    return Boolean(invoice.get('documentNumber')) || IMMUTABLE_STATUSES.has(getInvoiceStatus(invoice));
}

function validateImmutableUpdate(
    invoice: Invoice,
    updateData: Record<string, unknown>,
    shouldReplaceLines: boolean
): string | null {
    if (!isImmutableInvoice(invoice)) return null;

    const status = getInvoiceStatus(invoice);
    if (status === INVOICE_STATUS.VOID || status === INVOICE_STATUS.CREDITED) {
        return 'Documento fiscale gia stornato/accreditato: non e modificabile.';
    }

    if (shouldReplaceLines) {
        return 'Documento fiscale gia emesso: le righe non sono modificabili. Usa una nota di credito/storno.';
    }

    const changedFields = Object.keys(updateData).filter((key) => updateData[key] !== undefined);
    const forbidden = changedFields.filter((key) => !PAYMENT_UPDATE_FIELDS.has(key));
    if (forbidden.length > 0) {
        return `Documento fiscale gia emesso: campi non modificabili (${forbidden.join(', ')}).`;
    }

    if (
        updateData.status !== undefined &&
        ![INVOICE_STATUS.ISSUED, INVOICE_STATUS.PAID].includes(normalizeStatus(updateData.status) as any)
    ) {
        return 'Lo stato fiscale void/credited va gestito dagli endpoint dedicati, non da update generico.';
    }

    return null;
}

async function recordInvoiceAudit(
    req: Request,
    schema: string,
    action: string,
    invoice: Invoice | Record<string, unknown>,
    metadata?: Record<string, unknown>
): Promise<void> {
    const read = (key: string) =>
        typeof (invoice as any).get === 'function' ? (invoice as any).get(key) : (invoice as any)[key];

    await recordAuditEvent({
        schema,
        tenantId: req.user!.tenants[0].id,
        actorId: req.user!.id,
        action,
        resource: 'invoice',
        resourceId: (read('id') as string | undefined) ?? null,
        patientId: (read('patientID') as string | undefined) ?? null,
        metadata,
        req
    });
}

function buildRecipientSnapshot(patient: Record<string, unknown>): InvoiceRecipientSnapshot {
    const asString = (value: unknown): string | null =>
        typeof value === 'string' && value.trim() ? value.trim() : null;
    const birthday = patient.birthday ? new Date(patient.birthday as Date).toISOString().slice(0, 10) : null;

    return {
        name: asString(patient.name),
        surname: asString(patient.surname),
        fiscalCode: asString(patient.fiscalCode),
        address: asString(patient.address),
        birthday,
        placeBirth: asString(patient.placeBirth)
    };
}

export const saveInvoice = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped, ProductScoped, ServiceScoped, InvoiceProductScoped, InvoiceServiceScoped } =
        getScopedModels(schema);

    const { products: requestedProducts = [], services: requestedServices = [], agendaEventId, ...invoiceFields } = req.body;

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

    // --- Dati del cedente/prestatore: senza non si emette. ---
    // Il controllo sta QUI e non solo nella UI perché è un requisito di validità del documento
    // (art. 21 DPR 633/72): un client che chiamasse direttamente l'API produrrebbe altrimenti
    // fatture prive dei dati obbligatori, già numerate e quindi non eliminabili senza buchi.
    const tenantId = req.user!.tenants[0].id;
    const issuerTenant = await Tenant.findByPk(tenantId);
    if (!issuerTenant) {
        return sendErrorResponse(res, 404, 'Struttura/tenant non trovato');
    }
    const issuerData = issuerTenant.get({ plain: true }) as any;
    const requestedStatus = normalizeStatus(invoiceFields.status);
    const isDraft = requestedStatus === INVOICE_STATUS.DRAFT;
    const initialStatus = isDraft
        ? INVOICE_STATUS.DRAFT
        : requestedStatus === INVOICE_STATUS.PAID
          ? INVOICE_STATUS.PAID
          : INVOICE_STATUS.ISSUED;
    const missingIssuerFields = getMissingIssuerFields(issuerData);
    if (!isDraft && missingIssuerFields.length > 0) {
        return sendErrorResponse(
            res,
            422,
            `Dati di fatturazione dello studio incompleti: ${missingIssuerFields.join(', ')}. ` +
                'Completali in Impostazioni → Dati aziendali prima di emettere il documento.'
        );
    }
    const issuer = isDraft ? null : buildIssuerSnapshot(issuerData);

    // Il regime fiscale dello studio decide IVA, natura, ritenuta e bollo: va applicato PRIMA di
    // calcolare i totali, non dopo (vedi docs/REGIME_FISCALE_IT.md).
    const fiscalProfile = resolveFiscalProfile(issuerData);
    const fiscal = applyFiscalRules({
        profile: fiscalProfile,
        invoiceFields,
        evalLines: { products: productLines.map(toEvalLine), services: serviceLines.map(toEvalLine) }
    });

    // --- Adempimenti fiscali: numerazione progressiva senza "buchi" per anno fiscale, e
    // verifica automatica dell'eventuale opposizione del paziente all'invio Sistema TS. ---
    const fiscalYear =
        invoiceFields.documentYear ?? new Date(invoiceFields.emissionDate ?? Date.now()).getFullYear();

    let stsExcluded = Boolean(invoiceFields.stsExcluded);
    let recipient: InvoiceRecipientSnapshot | null = null;
    if (invoiceFields.patientID) {
        // Si può fatturare solo a un paziente che si ha il diritto di vedere.
        const patient = await Patient.schema(schema).findOne({
            where: { id: invoiceFields.patientID, ...patientScopeWhere(req, schema, 'id') }
        });
        if (!patient) {
            return sendErrorResponse(res, 404, 'Paziente non trovato');
        }
        if (patient.get('stsOppositionToDataSending')) {
            stsExcluded = true;
        }
        recipient = buildRecipientSnapshot(patient.get({ plain: true }) as unknown as Record<string, unknown>);
    }

    // Numerazione progressiva + creazione fattura + creazione righe in un'UNICA transazione:
    // se una qualsiasi parte fallisce, non deve restare un numero "bruciato" senza fattura, né
    // una fattura senza le sue righe.
    const invoice = await sequelize.transaction(async (t) => {
        let nextNumber: number | null = null;
        if (!isDraft) {
            const tenant = await Tenant.findByPk(tenantId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!tenant) {
                throw new Error('Tenant non trovato: impossibile assegnare il numero progressivo del documento');
            }
            const counters: Record<string, number> = {
                ...(tenant.get('lastDocumentNumberByYear') as Record<string, number>)
            };
            nextNumber = (counters[fiscalYear] || 0) + 1;
            counters[fiscalYear] = nextNumber;
            await tenant.update({ lastDocumentNumberByYear: counters }, { transaction: t });
        }

        const createdInvoice = await InvoiceScoped.create(
            {
                ...invoiceFields,
                ...fiscal.fields,
                ...toPersistedTotals(fiscal.totals),
                fiscalNotes: fiscal.fiscalNotes,
                documentNumber: nextNumber,
                documentYear: isDraft ? null : fiscalYear,
                status: initialStatus,
                issuedAt: isDraft ? null : new Date(),
                stsExcluded,
                recipient,
                issuer
            },
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

        // Fattura emessa a partire da un appuntamento: il collegamento va scritto nella STESSA
        // transazione, altrimenti un errore qui lascerebbe una fattura senza appuntamento
        // collegato e la dashboard mostrerebbe di nuovo "da emettere" per una seduta già fatturata.
        if (agendaEventId && !isDraft) {
            await AgendaEvent.schema(schema).update(
                { invoiceId },
                { where: { id: agendaEventId }, transaction: t }
            );
        }

        return createdInvoice;
    });

    const invoiceWithLines = await InvoiceScoped.findByPk(invoice.get('id') as string, {
        include: [
            { model: InvoiceProductScoped, as: 'products' },
            { model: InvoiceServiceScoped, as: 'services' }
        ]
    });

    if (invoiceWithLines) {
        await recordInvoiceAudit(
            req,
            schema,
            isDraft ? 'invoice.draft_created' : 'invoice.issued',
            invoiceWithLines,
            { status: initialStatus, documentNumber: invoiceWithLines.get('documentNumber') }
        );
    }

    return sendSuccessResponse(res, 201, invoiceWithLines, 'Invoice Created');
});

export const findAllInvoices = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped, InvoiceProductScoped, InvoiceServiceScoped } = getScopedModels(schema);

    const page = parseInt((req.query.page as string) ?? '1', 10);
    const size = parseInt((req.query.size as string) ?? '10', 10);

    const { count, rows } = await InvoiceScoped.findAndCountAll({
        // Le fatture non hanno un proprietario: l'ampiezza si eredita dai pazienti visibili.
        where: patientScopeWhere(req, schema, 'patientID'),
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
            [Op.and]: [
                patientScopeWhere(req, schema, 'patientID'),
                {
                    [Op.or]: [
                        sequelizeWhere(fn('LOWER', col('status')), 'LIKE', `%${query.toLowerCase()}%`),
                        sequelizeWhere(fn('LOWER', col('paymentMethod')), 'LIKE', `%${query.toLowerCase()}%`)
                    ]
                }
            ]
        }
    });

    return sendSuccessResponse(res, 200, invoices, 'Ricerca completata');
});

export const findOneInvoice = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped, InvoiceProductScoped, InvoiceServiceScoped } = getScopedModels(schema);

    const invoice = await InvoiceScoped.findOne({
        where: { id: req.params.invoiceId, ...patientScopeWhere(req, schema, 'patientID') },
        include: [
            { model: InvoiceProductScoped, as: 'products' },
            { model: InvoiceServiceScoped, as: 'services' }
        ]
    });

    if (!invoice) {
        return sendErrorResponse(res, 404, 'Fattura non trovata');
    }

    // Fatture create prima dell'introduzione dello snapshot: si ripiega sui dati correnti
    // dello studio, così la stampa resta completa. Il documento NON viene modificato: il
    // ripiego vale solo per la risposta.
    const plainInvoice = invoice.get({ plain: true }) as unknown as Record<string, unknown>;
    if (!plainInvoice.issuer) {
        const tenant = await Tenant.findByPk(req.user!.tenants[0].id);
        plainInvoice.issuer = tenant ? buildIssuerSnapshot(tenant.get({ plain: true }) as any) : null;
        plainInvoice.issuerIsFallback = true;
    }
    if (!plainInvoice.recipient && plainInvoice.patientID) {
        const patient = await Patient.schema(schema).findByPk(plainInvoice.patientID as string);
        plainInvoice.recipient = patient
            ? buildRecipientSnapshot(patient.get({ plain: true }) as unknown as Record<string, unknown>)
            : null;
        plainInvoice.recipientIsFallback = true;
    }

    return sendSuccessResponse(res, 200, { invoice: plainInvoice }, 'Fattura caricata correttamente');
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

    const existingInvoice = await InvoiceScoped.findOne({
        where: { id, ...patientScopeWhere(req, schema, 'patientID') }
    });
    if (!existingInvoice) {
        return sendErrorResponse(res, 404, 'Fattura non trovata');
    }

    const body = req.body.invoice ?? req.body;
    const { products: requestedProducts, services: requestedServices, ...invoiceFields } = body;
    const shouldReplaceLines = Array.isArray(requestedProducts) || Array.isArray(requestedServices);

    let updateData: Record<string, unknown> = { ...invoiceFields };
    const immutableUpdateError = validateImmutableUpdate(existingInvoice, updateData, shouldReplaceLines);
    if (immutableUpdateError) {
        return sendErrorResponse(res, 409, immutableUpdateError);
    }
    if (
        !isImmutableInvoice(existingInvoice) &&
        updateData.status !== undefined &&
        normalizeStatus(updateData.status) !== INVOICE_STATUS.DRAFT
    ) {
        return sendErrorResponse(res, 409, 'Per emettere una bozza usa POST /invoice/:invoiceId/issue');
    }

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

        // Il regime da applicare è quello congelato sul documento (`issuer.taxRegime`), non quello
        // corrente dello studio: correggere una fattura del 2025 emessa in forfettario non deve
        // trasformarla in una fattura con IVA solo perché nel frattempo si è passati all'ordinario.
        // Le altre impostazioni (importo bollo, aliquote proposte) restano quelle attuali del tenant.
        const issuerSnapshot = existingInvoice.get('issuer') as { taxRegime?: string | null } | null;
        const issuerTenant = await Tenant.findByPk(req.user!.tenants[0].id);
        const profile = resolveFiscalProfile({
            ...((issuerTenant?.get({ plain: true }) as any) ?? {}),
            taxRegime: issuerSnapshot?.taxRegime ?? (issuerTenant?.get('taxRegime') as string | null)
        });

        const fiscal = applyFiscalRules({
            profile,
            invoiceFields: {
                discountType: invoiceFields.discountType ?? existingInvoice.get('discountType'),
                discountAmount: invoiceFields.discountAmount ?? existingInvoice.get('discountAmount'),
                isRivals: invoiceFields.isRivals ?? existingInvoice.get('isRivals'),
                rivals: invoiceFields.rivals ?? existingInvoice.get('rivals'),
                isCashPro: invoiceFields.isCashPro ?? existingInvoice.get('isCashPro'),
                isTaxWithholding: invoiceFields.isTaxWithholding ?? existingInvoice.get('isTaxWithholding'),
                taxWithholding: invoiceFields.taxWithholding ?? existingInvoice.get('taxWithholding'),
                vatNature: invoiceFields.vatNature ?? existingInvoice.get('vatNature'),
                isStamp: invoiceFields.isStamp ?? existingInvoice.get('isStamp'),
                stampAmount: invoiceFields.stampAmount ?? existingInvoice.get('stampAmount'),
                stampChargedToPatient:
                    invoiceFields.stampChargedToPatient ?? existingInvoice.get('stampChargedToPatient')
            },
            evalLines: { products: productLines.map(toEvalLine), services: serviceLines.map(toEvalLine) }
        });

        updateData = {
            ...updateData,
            ...fiscal.fields,
            ...toPersistedTotals(fiscal.totals),
            fiscalNotes: fiscal.fiscalNotes
        };

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
    if (updatedInvoice) {
        await recordInvoiceAudit(req, schema, 'invoice.updated', updatedInvoice, {
            fields: Object.keys(updateData),
            replacedLines: shouldReplaceLines
        });
    }
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

    const removedInvoice = await InvoiceScoped.findOne({
        where: { id, ...patientScopeWhere(req, schema, 'patientID') }
    });
    if (!removedInvoice) {
        return sendErrorResponse(res, 404, 'Fattura non trovata');
    }
    if (isImmutableInvoice(removedInvoice)) {
        return sendErrorResponse(
            res,
            409,
            'Documento fiscale gia emesso: non puo essere cancellato fisicamente. Usa storno o nota di credito.'
        );
    }

    await Promise.all([
        InvoiceProductScoped.destroy({ where: { InvoiceId: id } }),
        InvoiceServiceScoped.destroy({ where: { InvoiceId: id } }),
        // L'appuntamento eventualmente collegato torna "da fatturare": senza questo resterebbe
        // puntato a una fattura inesistente e la dashboard lo darebbe per emesso.
        AgendaEvent.schema(schema).update({ invoiceId: null }, { where: { invoiceId: id } })
    ]);
    await InvoiceScoped.destroy({ where: { id } });
    await recordInvoiceAudit(req, schema, 'invoice.draft_deleted', removedInvoice);

    return sendSuccessResponse(res, 200, { removedInvoice }, 'Fattura eliminata correttamente');
});

export const issueInvoice = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped, InvoiceProductScoped, InvoiceServiceScoped } = getScopedModels(schema);
    const id = req.params.invoiceId;
    const tenantId = req.user!.tenants[0].id;

    const invoice = await InvoiceScoped.findOne({
        where: { id, ...patientScopeWhere(req, schema, 'patientID') },
        include: [
            { model: InvoiceProductScoped, as: 'products' },
            { model: InvoiceServiceScoped, as: 'services' }
        ]
    });
    if (!invoice) {
        return sendErrorResponse(res, 404, 'Fattura non trovata');
    }
    if (isImmutableInvoice(invoice)) {
        return sendErrorResponse(res, 409, 'Documento gia emesso');
    }

    const issuerTenant = await Tenant.findByPk(tenantId);
    const issuerData = issuerTenant?.get({ plain: true }) as any;
    const missingIssuerFields = getMissingIssuerFields(issuerData);
    if (missingIssuerFields.length > 0) {
        return sendErrorResponse(
            res,
            422,
            `Dati di fatturazione dello studio incompleti: ${missingIssuerFields.join(', ')}.`
        );
    }

    const plain = invoice.get({ plain: true }) as any;
    const products = (plain.products ?? []).map((line: any) => ({
        sellingPrice: Number(line.productPrice) || 0,
        quantity: Number(line.quantity) || 1,
        productVat: line.productVat ?? null
    }));
    const services = (plain.services ?? []).map((line: any) => ({
        sellingPrice: Number(line.servicePrice) || 0,
        quantity: Number(line.quantity) || 1,
        productVat: line.serviceVat ?? null
    }));

    const profile = resolveFiscalProfile(issuerData);
    const fiscal = applyFiscalRules({
        profile,
        invoiceFields: plain,
        evalLines: { products, services }
    });
    const fiscalYear = plain.documentYear ?? new Date(plain.emissionDate ?? Date.now()).getFullYear();
    const issuer = buildIssuerSnapshot(issuerData);
    let stsExcluded = Boolean(plain.stsExcluded);
    let recipient = (plain.recipient as InvoiceRecipientSnapshot | null) ?? null;

    if (plain.patientID) {
        const patient = await Patient.schema(schema).findByPk(plain.patientID);
        if (patient?.get('stsOppositionToDataSending')) {
            stsExcluded = true;
        }
        if (patient) {
            recipient = buildRecipientSnapshot(patient.get({ plain: true }) as unknown as Record<string, unknown>);
        }
    }

    await sequelize.transaction(async (t) => {
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

        await invoice.update(
            {
                ...fiscal.fields,
                ...toPersistedTotals(fiscal.totals),
                fiscalNotes: fiscal.fiscalNotes,
                documentNumber: nextNumber,
                documentYear: fiscalYear,
                status: INVOICE_STATUS.ISSUED,
                issuedAt: new Date(),
                issuer,
                stsExcluded,
                recipient
            },
            { transaction: t }
        );
    });

    const issued = await InvoiceScoped.findByPk(id, {
        include: [
            { model: InvoiceProductScoped, as: 'products' },
            { model: InvoiceServiceScoped, as: 'services' }
        ]
    });
    if (issued) {
        await recordInvoiceAudit(req, schema, 'invoice.issued', issued, {
            documentNumber: issued.get('documentNumber')
        });
    }

    return sendSuccessResponse(res, 200, issued, 'Fattura emessa correttamente');
});

export const voidInvoice = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped } = getScopedModels(schema);
    const id = req.params.invoiceId;
    const reason = `${req.body?.reason ?? ''}`.trim();

    const invoice = await InvoiceScoped.findOne({
        where: { id, ...patientScopeWhere(req, schema, 'patientID') }
    });
    if (!invoice) {
        return sendErrorResponse(res, 404, 'Fattura non trovata');
    }
    if (!isImmutableInvoice(invoice)) {
        return sendErrorResponse(res, 409, 'Una bozza non va stornata: puo essere cancellata.');
    }
    if ([INVOICE_STATUS.VOID, INVOICE_STATUS.CREDITED].includes(getInvoiceStatus(invoice) as any)) {
        return sendErrorResponse(res, 409, 'Documento gia stornato/accreditato');
    }

    await invoice.update({
        status: INVOICE_STATUS.VOID,
        voidedAt: new Date(),
        voidedBy: req.user!.id,
        voidReason: reason || null
    });
    await recordInvoiceAudit(req, schema, 'invoice.voided', invoice, {
        reason: reason || null,
        stsSent: invoice.get('stsSent')
    });

    return sendSuccessResponse(res, 200, invoice, 'Fattura stornata correttamente');
});

export const createCreditNote = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped, InvoiceProductScoped, InvoiceServiceScoped } = getScopedModels(schema);
    const sourceId = req.params.invoiceId;
    const tenantId = req.user!.tenants[0].id;

    const source = await InvoiceScoped.findOne({
        where: { id: sourceId, ...patientScopeWhere(req, schema, 'patientID') },
        include: [
            { model: InvoiceProductScoped, as: 'products' },
            { model: InvoiceServiceScoped, as: 'services' }
        ]
    });
    if (!source) {
        return sendErrorResponse(res, 404, 'Fattura non trovata');
    }
    if (!isImmutableInvoice(source)) {
        return sendErrorResponse(res, 409, 'La nota di credito richiede una fattura emessa.');
    }
    if ([INVOICE_STATUS.VOID, INVOICE_STATUS.CREDITED].includes(getInvoiceStatus(source) as any)) {
        return sendErrorResponse(res, 409, 'Documento gia stornato/accreditato');
    }
    if ((source.get('documentType') as string | null) === 'nota_di_credito') {
        return sendErrorResponse(res, 409, 'Non si crea una nota di credito da una nota di credito.');
    }

    const negate = (value: unknown): number | null => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? -Math.abs(parsed) : null;
    };
    const fiscalYear = new Date().getFullYear();
    const sourcePlain = source.get({ plain: true }) as any;

    const creditNote = await sequelize.transaction(async (t) => {
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

        const created = await InvoiceScoped.create(
            {
                emissionDate: new Date(),
                invoiceNet: negate(source.get('invoiceNet')),
                invoiceTotal: negate(source.get('invoiceTotal')),
                sellingPrice: negate(source.get('sellingPrice')),
                discSellingPrice: negate(source.get('discSellingPrice')),
                invoiceVAT: negate(source.get('invoiceVAT')),
                patientID: source.get('patientID'),
                isCashPro: source.get('isCashPro'),
                cashPro: source.get('cashPro'),
                isRivals: source.get('isRivals'),
                rivals: source.get('rivals'),
                isTaxWithholding: source.get('isTaxWithholding'),
                taxWithholding: source.get('taxWithholding'),
                isStamp: false,
                stampAmount: null,
                stampChargedToPatient: false,
                paymentMethod: source.get('paymentMethod'),
                discountType: source.get('discountType'),
                discountAmount: source.get('discountAmount'),
                status: INVOICE_STATUS.ISSUED,
                documentNumber: nextNumber,
                documentYear: fiscalYear,
                documentType: 'nota_di_credito',
                vatNature: source.get('vatNature'),
                stsExpenseTypeCode: source.get('stsExpenseTypeCode'),
                stsExcluded: true,
                stsSent: false,
                issuedAt: new Date(),
                sourceInvoiceId: sourceId,
                recipient: source.get('recipient'),
                issuer: source.get('issuer'),
                fiscalNotes: [
                    ...(((source.get('fiscalNotes') as string[] | null) ?? [])),
                    `Nota di credito riferita al documento ${source.get('documentNumber')}/${source.get('documentYear')}`
                ]
            },
            { transaction: t }
        );

        const creditId = created.get('id') as string;
        await Promise.all([
            ...(sourcePlain.products ?? []).map((line: any) =>
                InvoiceProductScoped.create(
                    {
                        InvoiceId: creditId,
                        ProductId: line.ProductId,
                        quantity: line.quantity,
                        productPrice: negate(line.productPrice),
                        totalPrice: negate(line.totalPrice),
                        percentageDiscount: line.percentageDiscount,
                        discountAmount: line.discountAmount,
                        productName: line.productName,
                        productVat: line.productVat
                    },
                    { transaction: t }
                )
            ),
            ...(sourcePlain.services ?? []).map((line: any) =>
                InvoiceServiceScoped.create(
                    {
                        InvoiceId: creditId,
                        ServiceId: line.ServiceId,
                        quantity: line.quantity,
                        servicePrice: negate(line.servicePrice),
                        totalPrice: negate(line.totalPrice),
                        percentageDiscount: line.percentageDiscount,
                        discountAmount: line.discountAmount,
                        serviceName: line.serviceName,
                        serviceVat: line.serviceVat
                    },
                    { transaction: t }
                )
            ),
            source.update(
                {
                    status: INVOICE_STATUS.CREDITED,
                    creditedAt: new Date(),
                    creditedBy: req.user!.id
                },
                { transaction: t }
            )
        ]);

        return created;
    });

    await recordInvoiceAudit(req, schema, 'invoice.credit_note_created', creditNote, {
        sourceInvoiceId: sourceId
    });
    await recordInvoiceAudit(req, schema, 'invoice.credited', source, {
        creditNoteId: creditNote.get('id')
    });

    const payload = await InvoiceScoped.findByPk(creditNote.get('id') as string, {
        include: [
            { model: InvoiceProductScoped, as: 'products' },
            { model: InvoiceServiceScoped, as: 'services' }
        ]
    });

    return sendSuccessResponse(res, 201, payload, 'Nota di credito creata correttamente');
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

    // Serve solo come ripiego per i documenti emessi prima dell'introduzione di `invoice.issuer`:
    // per tutti gli altri l'identificativo dell'erogatore viene letto dallo snapshot del documento.
    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) {
        return sendErrorResponse(res, 404, 'Struttura/tenant non trovato');
    }

    const invoices = await InvoiceScoped.findAll({
        where: {
            documentYear: year,
            stsExcluded: false,
            stsSent: false,
            [Op.or]: [
                { status: { [Op.in]: [INVOICE_STATUS.ISSUED, INVOICE_STATUS.PAID] } },
                { status: { [Op.is]: null } }
            ],
            ...patientScopeWhere(req, schema, 'patientID')
        }
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
        await recordAuditEvent({
            schema,
            tenantId,
            actorId: req.user!.id,
            action: 'sts.export.marked_sent',
            resource: 'sts',
            metadata: { year, invoiceIds: includedInvoiceIds },
            req
        });
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
    issueInvoice,
    voidInvoice,
    createCreditNote,
    exportSistemaTS
};


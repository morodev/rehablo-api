import { Request, Response } from 'express';
import { Op, fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { patientScopeWhere, scopeWhere } from '../../../middleware/rbac.js';
import { sequelize } from '../../../config/database.js';
import Invoice from '../models/invoice.model.js';
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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENDA_SCOPE_FIELDS = {
    ownerField: 'calendarId',
    structureField: 'structureId',
    includeUnassigned: false
};

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

export const saveInvoice = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped, ProductScoped, ServiceScoped, InvoiceProductScoped, InvoiceServiceScoped } =
        getScopedModels(schema);

    const { products: requestedProducts = [], services: requestedServices = [], agendaEventId, ...invoiceFields } = req.body;

    if (agendaEventId != null && (typeof agendaEventId !== 'string' || !UUID_REGEX.test(agendaEventId))) {
        return sendErrorResponse(res, 400, 'Identificativo appuntamento non valido');
    }

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
    const missingIssuerFields = getMissingIssuerFields(issuerTenant?.get({ plain: true }) as any);
    if (missingIssuerFields.length > 0) {
        return sendErrorResponse(
            res,
            422,
            `Dati di fatturazione dello studio incompleti: ${missingIssuerFields.join(', ')}. ` +
                'Completali in Impostazioni → Dati aziendali prima di emettere il documento.'
        );
    }
    const issuerData = issuerTenant!.get({ plain: true }) as any;
    const issuer = buildIssuerSnapshot(issuerData);

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
    }

    // Numerazione progressiva + creazione fattura + creazione righe in un'UNICA transazione:
    // se una qualsiasi parte fallisce, non deve restare un numero "bruciato" senza fattura, né
    // una fattura senza le sue righe.
    const transactionResult = await sequelize.transaction(async (t) => {
        let agendaEvent: AgendaEvent | null = null;

        if (agendaEventId) {
            // Il lock rende atomico il controllo "non ancora fatturato": una seconda richiesta
            // per lo stesso appuntamento aspetta la prima e, dopo il commit, trova invoiceId.
            agendaEvent = await AgendaEvent.schema(schema).findOne({
                where: { id: agendaEventId, ...scopeWhere(req, AGENDA_SCOPE_FIELDS) },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            if (!agendaEvent) {
                return { kind: 'agenda-not-found' } as const;
            }

            if (agendaEvent.get('recurrence')) {
                return { kind: 'recurring-event' } as const;
            }

            const agendaPatient = agendaEvent.get('patient') as Record<string, unknown> | null;
            if (!agendaPatient?.id || agendaPatient.id !== invoiceFields.patientID) {
                return { kind: 'patient-mismatch' } as const;
            }

            const linkedInvoiceId = agendaEvent.get('invoiceId') as string | null;
            if (linkedInvoiceId) {
                await agendaEvent.update(
                    { status: 'COMPLETED', erasable: false },
                    { transaction: t }
                );
                return { kind: 'already-invoiced', invoiceId: linkedInvoiceId } as const;
            }

            // Difesa aggiuntiva per eventuali record riallineati/migrati nei quali il riferimento
            // sulla fattura esiste ma quello sull'appuntamento non e' ancora valorizzato.
            const invoiceForAgenda = await InvoiceScoped.findOne({
                where: { agendaEventId },
                attributes: ['id'],
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (invoiceForAgenda) {
                const invoiceId = invoiceForAgenda.get('id') as string;
                await agendaEvent.update(
                    { invoiceId, status: 'COMPLETED', erasable: false },
                    { transaction: t }
                );
                return { kind: 'already-invoiced', invoiceId } as const;
            }

            // La fattura rende automaticamente la prestazione COMPLETED: non puo' quindi
            // essere emessa prima che la seduta sia iniziata. Il controllo usa l'orologio
            // del server ed e' dentro la stessa transazione/lock degli altri vincoli, percio'
            // non e' aggirabile modificando il client o inviando direttamente la richiesta.
            const agendaStartValue = agendaEvent.get('start') as string | null;
            const agendaStartTimestamp = agendaStartValue
                ? Date.parse(agendaStartValue)
                : Number.NaN;
            if (
                Number.isFinite(agendaStartTimestamp) &&
                agendaStartTimestamp > Date.now()
            ) {
                return {
                    kind: 'future-appointment',
                    availableAt: agendaStartValue
                } as const;
            }
        }

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
            {
                ...invoiceFields,
                agendaEventId: agendaEventId ?? null,
                ...fiscal.fields,
                ...toPersistedTotals(fiscal.totals),
                fiscalNotes: fiscal.fiscalNotes,
                documentNumber: nextNumber,
                documentYear: fiscalYear,
                stsExcluded,
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
        if (agendaEvent) {
            await agendaEvent.update(
                { invoiceId, status: 'COMPLETED', erasable: false },
                { transaction: t }
            );
        }

        return { kind: 'created', invoice: createdInvoice } as const;
    });

    if (transactionResult.kind === 'agenda-not-found') {
        return sendErrorResponse(res, 404, 'Appuntamento non trovato o non accessibile');
    }
    if (transactionResult.kind === 'patient-mismatch') {
        return sendErrorResponse(res, 422, 'Il paziente della fattura non coincide con quello dell’appuntamento');
    }
    if (transactionResult.kind === 'recurring-event') {
        return sendErrorResponse(
            res,
            422,
            'Prima di fatturare, separa la singola occorrenza dalla serie ricorrente'
        );
    }
    if (transactionResult.kind === 'already-invoiced') {
        return sendErrorResponse(
            res,
            409,
            'Per questo appuntamento è già stata emessa una fattura',
            { invoiceId: transactionResult.invoiceId }
        );
    }
    if (transactionResult.kind === 'future-appointment') {
        return sendErrorResponse(
            res,
            409,
            'Non è possibile fatturare un appuntamento futuro. La fattura sarà disponibile dall’inizio della seduta.',
            { availableAt: transactionResult.availableAt }
        );
    }

    const invoice = transactionResult.invoice;

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
    // Il legame con l'appuntamento nasce esclusivamente nel flusso atomico di saveInvoice:
    // consentirne la modifica con una PUT aggirerebbe lock e controllo uno-a-uno.
    const {
        products: requestedProducts,
        services: requestedServices,
        agendaEventId: _immutableAgendaEventId,
        ...invoiceFields
    } = body;
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

    const linkedAgendaEvent = await AgendaEvent.schema(schema).findOne({
        where: { invoiceId: id },
        attributes: ['id']
    });
    if (linkedAgendaEvent) {
        return sendErrorResponse(
            res,
            409,
            'Una fattura collegata a un appuntamento effettuato non può essere eliminata. Utilizza lo storno.'
        );
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


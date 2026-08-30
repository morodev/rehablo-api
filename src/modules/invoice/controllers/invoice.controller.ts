import { Request, Response } from 'express';
import { Op, fn, col, where as sequelizeWhere } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { getUserId, patientScopeWhere, scopeWhere } from '../../../middleware/rbac.js';
import { sequelize } from '../../../config/database.js';
import Invoice from '../models/invoice.model.js';
import InvoiceProduct from '../models/invoiceProduct.model.js';
import InvoiceService from '../models/invoiceService.model.js';
import InvoicePayment from '../models/invoicePayment.model.js';
import Product from '../../products-services/models/product.model.js';
import Service from '../../products-services/models/service.model.js';
import Patient from '../../patients/models/patient.model.js';
import Tenant from '../../auth/models/tenant.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import EventType from '../../agenda/models/eventType.model.js';
import { User } from '../../auth/models/index.js';
import InvoiceAgendaEvent from '../models/invoiceAgendaEvent.model.js';
import { getInvoiceAgendaLinksByEventIds } from '../services/invoiceAgendaEvent.service.js';
import { evalTotals, EvalTotalsResult, toPersistedTotals } from '../utils/evalTotals.js';
import { buildIssuerSnapshot, getMissingIssuerFields } from '../utils/issuer.js';
import { buildFiscalNotes, FiscalProfile, isStampDutyDue, resolveFiscalProfile } from '../utils/fiscalRegime.js';
import { buildSistemaTSRecord, generateSistemaTSXml, SistemaTSRecord } from '../utils/sistemaTS.js';
import { decorateInvoicesWithPayments } from '../services/payment.service.js';

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
    const InvoicePaymentScoped = InvoicePayment.schema(schema);
    const InvoiceAgendaEventScoped = InvoiceAgendaEvent.schema(schema);


    return {
        InvoiceScoped,
        ProductScoped,
        ServiceScoped,
        InvoiceProductScoped,
        InvoiceServiceScoped,
        InvoicePaymentScoped,
        InvoiceAgendaEventScoped
    };
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

const invoiceDateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
});

function invoiceLocalDate(value: Date): string {
    const parts = invoiceDateFormatter.formatToParts(value);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${byType.year}-${byType.month}-${byType.day}`;
}

/**
 * Appuntamenti completati e non ancora fatturati utilizzabili nella nuova fattura.
 * Prezzo e IVA arrivano dal servizio di catalogo collegato, mai dallo snapshot dell'agenda.
 */
export const findEligibleAppointments = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const patientId = String(req.query.patientId ?? '');
    const through = String(req.query.through ?? '');
    if (!UUID_REGEX.test(patientId)) {
        return sendErrorResponse(res, 400, 'Paziente non valido');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(through)) {
        return sendErrorResponse(res, 400, 'Data limite non valida');
    }

    const patient = await Patient.schema(schema).findOne({
        where: { [Op.and]: [{ id: patientId }, patientScopeWhere(req, schema, 'id')] },
        attributes: ['id']
    });
    if (!patient) {
        return sendErrorResponse(res, 404, 'Paziente non trovato');
    }

    const rows = await AgendaEvent.schema(schema).findAll({
        where: {
            [Op.and]: [
                { [Op.or]: [{ patientId }, { patient: { id: patientId } as any }] },
                { [Op.or]: [{ recurrence: null }, { recurrence: '' }] },
                { status: { [Op.in]: ['COMPLETED', 'completed'] } },
                { invoiceId: null },
                scopeWhere(req, AGENDA_SCOPE_FIELDS)
            ]
        },
        order: [['start', 'DESC']]
    });

    const now = Date.now();
    const datedRows = rows.filter((event) => {
        const timestamp = Date.parse(String(event.get('start') ?? ''));
        return Number.isFinite(timestamp)
            && timestamp <= now
            && invoiceLocalDate(new Date(timestamp)) <= through;
    });
    const eventIds = datedRows.map((event) => event.id);
    const existingLinks = await getInvoiceAgendaLinksByEventIds(schema, eventIds);
    const alreadyLinked = new Set(existingLinks.map((link) => link.agendaEventId));
    const eligibleRows = datedRows.filter((event) => !alreadyLinked.has(event.id));

    const eventTypeIds = [...new Set(eligibleRows.map((event) => event.eventTypeId).filter(Boolean))] as string[];
    const eventTypes = eventTypeIds.length
        ? await EventType.schema(schema).findAll({ where: { id: { [Op.in]: eventTypeIds } } })
        : [];
    const eventTypeById = new Map(eventTypes.map((eventType) => [eventType.id, eventType]));
    const serviceIds = [...new Set(eventTypes.map((eventType) => eventType.linkedServiceId).filter(Boolean))] as string[];
    const services = serviceIds.length
        ? await Service.schema(schema).findAll({ where: { id: { [Op.in]: serviceIds }, isActive: true } })
        : [];
    const serviceById = new Map(services.map((service) => [service.id, service]));

    const operatorIds = [...new Set(eligibleRows.map((event) => event.calendarId).filter(Boolean))] as string[];
    const operators = operatorIds.length
        ? await User.findAll({ where: { id: { [Op.in]: operatorIds } }, attributes: ['id', 'name', 'surname'] })
        : [];
    const operatorById = new Map(operators.map((operator) => [operator.id, operator]));

    const appointments = eligibleRows.map((event) => {
        const eventType = event.eventTypeId ? eventTypeById.get(event.eventTypeId) : null;
        const service = eventType?.linkedServiceId ? serviceById.get(eventType.linkedServiceId) : null;
        const operator = event.calendarId ? operatorById.get(event.calendarId) : null;
        return {
            id: event.id,
            start: event.start,
            end: event.end,
            title: event.title ?? eventType?.title ?? 'Prestazione',
            status: event.status,
            eventTypeId: event.eventTypeId ?? null,
            operatorId: event.calendarId ?? null,
            operatorName: operator
                ? [operator.name, operator.surname].filter(Boolean).join(' ')
                : 'Professionista non disponibile',
            service: service ? {
                id: service.id,
                type: 'SERVICE',
                name: service.name,
                code: service.code,
                description: service.description,
                productVat: service.productVat,
                sellingPrice: Number(service.sellingPrice) || 0,
                categoryId: service.categoryId,
                isActive: service.isActive
            } : null
        };
    });

    return sendSuccessResponse(res, 200, { appointments }, 'Appuntamenti fatturabili caricati');
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
    const {
        InvoiceScoped,
        ProductScoped,
        ServiceScoped,
        InvoiceProductScoped,
        InvoiceServiceScoped,
        InvoicePaymentScoped,
        InvoiceAgendaEventScoped
    } = getScopedModels(schema);

    const {
        products: requestedProducts = [],
        services: requestedServices = [],
        appointments: requestedAppointments,
        agendaEventId,
        paymentDate,
        status: requestedStatus,
        structureId: _clientStructureId,
        ...invoiceFields
    } = req.body;

    if (requestedAppointments !== undefined && !Array.isArray(requestedAppointments)) {
        return sendErrorResponse(res, 400, 'Elenco appuntamenti non valido');
    }

    const hasExplicitAppointments = Array.isArray(requestedAppointments);
    const appointmentSelections: Array<{ agendaEventId: string; serviceId: string | null }> =
        hasExplicitAppointments
            ? requestedAppointments.map((selection: any) => ({
                agendaEventId: selection?.agendaEventId,
                serviceId: selection?.serviceId ?? null
            }))
            : agendaEventId
                ? [{ agendaEventId, serviceId: requestedServices[0]?.id ?? null }]
                : [];

    if (appointmentSelections.length > 200) {
        return sendErrorResponse(res, 400, 'Puoi collegare al massimo 200 appuntamenti per fattura');
    }
    if (appointmentSelections.some((selection) =>
        typeof selection.agendaEventId !== 'string'
        || !UUID_REGEX.test(selection.agendaEventId)
        || (hasExplicitAppointments && (!selection.serviceId || !UUID_REGEX.test(selection.serviceId)))
    )) {
        return sendErrorResponse(res, 400, 'Identificativo appuntamento o servizio non valido');
    }
    const agendaEventIds = appointmentSelections.map((selection) => selection.agendaEventId);
    if (new Set(agendaEventIds).size !== agendaEventIds.length) {
        return sendErrorResponse(res, 400, 'Lo stesso appuntamento è stato selezionato più volte');
    }

    // Nel nuovo flusso le prestazioni degli appuntamenti sono risolte e aggiunte server-side;
    // `services` continua a contenere esclusivamente le righe manuali. Il vecchio flusso agenda,
    // che invia un singolo `agendaEventId`, ha già il servizio in `services` e resta invariato.
    const servicesWithAppointments = hasExplicitAppointments
        ? [
            ...requestedServices,
            ...appointmentSelections.map((selection) => ({ id: selection.serviceId, quantity: 1 }))
        ]
        : requestedServices;

    const [{ lines: productLines, missingId: missingProductId }, { lines: serviceLines, missingId: missingServiceId }] =
        await Promise.all([
            resolveCatalogLines(requestedProducts, ProductScoped),
            resolveCatalogLines(servicesWithAppointments, ServiceScoped)
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
    let invoiceStructureId = req.access?.structureId ?? null;
    if (invoiceFields.patientID) {
        // Si può fatturare solo a un paziente che si ha il diritto di vedere.
        const patient = await Patient.schema(schema).findOne({
            where: {
                [Op.and]: [
                    { id: invoiceFields.patientID },
                    patientScopeWhere(req, schema, 'id')
                ]
            }
        });
        if (!patient) {
            return sendErrorResponse(res, 404, 'Paziente non trovato');
        }
        invoiceStructureId = patient.get('structureId') as string | null;
        if (patient.get('stsOppositionToDataSending')) {
            stsExcluded = true;
        }
    }

    // Numerazione progressiva + creazione fattura + creazione righe in un'UNICA transazione:
    // se una qualsiasi parte fallisce, non deve restare un numero "bruciato" senza fattura, né
    // una fattura senza le sue righe.
    const transactionResult = await sequelize.transaction(async (t) => {
        let agendaEvents: AgendaEvent[] = [];

        if (agendaEventIds.length > 0) {
            // Tutti gli appuntamenti vengono bloccati nello stesso ordine: oltre a rendere atomico
            // il controllo evita deadlock fra due richieste concorrenti con selezioni sovrapposte.
            agendaEvents = await AgendaEvent.schema(schema).findAll({
                where: { id: { [Op.in]: agendaEventIds }, ...scopeWhere(req, AGENDA_SCOPE_FIELDS) },
                order: [['id', 'ASC']],
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            if (agendaEvents.length !== agendaEventIds.length) {
                return { kind: 'agenda-not-found' } as const;
            }

            if (agendaEvents.some((event) => event.get('recurrence'))) {
                return { kind: 'recurring-event' } as const;
            }
            const eventStructures = new Set(
                agendaEvents.map((event) => event.get('structureId') as string | null).filter(Boolean)
            );
            if (eventStructures.size > 1
                || (invoiceStructureId && [...eventStructures].some((id) => id !== invoiceStructureId))) {
                return { kind: 'structure-mismatch' } as const;
            }
            invoiceStructureId = ([...eventStructures][0] as string | undefined) ?? invoiceStructureId;

            const hasPatientMismatch = agendaEvents.some((event) => {
                const agendaPatient = event.get('patient') as Record<string, unknown> | null;
                const agendaPatientId = event.get('patientId') as string | null;
                return (agendaPatientId ?? agendaPatient?.id ?? null) !== invoiceFields.patientID;
            });
            if (hasPatientMismatch) {
                return { kind: 'patient-mismatch' } as const;
            }

            const cancelledEvent = agendaEvents.find((event) =>
                ['CANCELLED', 'CANCELED'].includes(String(event.get('status') ?? '').toUpperCase())
            );
            if (cancelledEvent) {
                return { kind: 'cancelled-appointment' } as const;
            }
            const waivedNoShow = agendaEvents.find((event) =>
                String(event.get('status') ?? '').toUpperCase() === 'NO_SHOW'
                && String(event.get('noShowBillingDecision') ?? '').toUpperCase() === 'WAIVED'
            );
            if (waivedNoShow) {
                return { kind: 'waived-no-show' } as const;
            }

            const legacyLinkedEvent = agendaEvents.find((event) => Boolean(event.get('invoiceId')));
            if (legacyLinkedEvent) {
                return {
                    kind: 'already-invoiced',
                    invoiceId: legacyLinkedEvent.get('invoiceId') as string
                } as const;
            }

            const existingLinks = await InvoiceAgendaEventScoped.findAll({
                where: { agendaEventId: { [Op.in]: agendaEventIds } },
                attributes: ['invoiceId'],
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (existingLinks.length > 0) {
                return {
                    kind: 'already-invoiced',
                    invoiceId: existingLinks[0].get('invoiceId') as string
                } as const;
            }

            // Difesa aggiuntiva per eventuali record riallineati/migrati nei quali il riferimento
            // sulla fattura esiste ma quello sull'appuntamento non e' ancora valorizzato.
            const invoiceForAgenda = await InvoiceScoped.findOne({
                where: { agendaEventId: { [Op.in]: agendaEventIds } },
                attributes: ['id'],
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (invoiceForAgenda) {
                const invoiceId = invoiceForAgenda.get('id') as string;
                return { kind: 'already-invoiced', invoiceId } as const;
            }

            // Nessun appuntamento futuro né successivo alla data di emissione può entrare nel
            // documento. Il controllo resta server-side e dentro gli stessi lock della creazione.
            const emissionDate = String(invoiceFields.emissionDate ?? invoiceLocalDate(new Date())).slice(0, 10);
            const invalidDateEvent = agendaEvents.find((event) => {
                const startValue = event.get('start') as string | null;
                const timestamp = startValue ? Date.parse(startValue) : Number.NaN;
                return !Number.isFinite(timestamp)
                    || timestamp > Date.now()
                    || invoiceLocalDate(new Date(timestamp)) > emissionDate;
            });
            if (invalidDateEvent) {
                return {
                    kind: 'future-appointment',
                    availableAt: invalidDateEvent.get('start') as string | null
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
                agendaEventId: agendaEventIds.length === 1 ? agendaEventIds[0] : null,
                structureId: invoiceStructureId,
                status: 'unpaid',
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
            ),
            ...appointmentSelections.map((selection) =>
                InvoiceAgendaEventScoped.create(
                    {
                        invoiceId,
                        agendaEventId: selection.agendaEventId,
                        serviceId: selection.serviceId
                    },
                    { transaction: t }
                )
            )
        ]);

        // Compatibility during the frontend/backend rolling deployment: an old client can still
        // emit an already-paid document. Convert that flag into a real, dated movement.
        if (String(requestedStatus ?? '').toLowerCase() === 'paid' && fiscal.totals.invoiceTotal > 0) {
            const paidAt = typeof paymentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(paymentDate)
                ? paymentDate
                : String(invoiceFields.emissionDate ?? new Date().toISOString()).slice(0, 10);
            await InvoicePaymentScoped.create(
                {
                    invoiceId,
                    amount: fiscal.totals.invoiceTotal,
                    paidAt: new Date(`${paidAt}T12:00:00.000Z`),
                    method: invoiceFields.paymentMethod ?? null,
                    source: 'USER',
                    status: 'POSTED',
                    createdByUserId: getUserId(req)
                },
                { transaction: t }
            );
            await createdInvoice.update({ status: 'paid' }, { transaction: t });
        }

        // Fattura emessa a partire da un appuntamento: il collegamento va scritto nella STESSA
        // transazione, altrimenti un errore qui lascerebbe una fattura senza appuntamento
        // collegato e la dashboard mostrerebbe di nuovo "da emettere" per una seduta già fatturata.
        if (agendaEvents.length > 0) {
            await Promise.all(agendaEvents.map((event) => event.update(
                {
                    ...(agendaEvents.length === 1 ? { invoiceId } : {}),
                    // La fattura descrive la scelta economica, non trasforma un'assenza
                    // in una prestazione erogata: il no-show resta tale nei report.
                    status: String(event.get('status') ?? '').toUpperCase() === 'NO_SHOW'
                        ? 'NO_SHOW'
                        : 'COMPLETED',
                    erasable: false
                },
                { transaction: t }
            )));
        }

        return { kind: 'created', invoice: createdInvoice } as const;
    });

    if (transactionResult.kind === 'agenda-not-found') {
        return sendErrorResponse(res, 404, 'Appuntamento non trovato o non accessibile');
    }
    if (transactionResult.kind === 'patient-mismatch') {
        return sendErrorResponse(res, 422, 'Il paziente della fattura non coincide con quello dell’appuntamento');
    }
    if (transactionResult.kind === 'structure-mismatch') {
        return sendErrorResponse(res, 422, 'Gli appuntamenti selezionati non appartengono alla stessa sede del paziente');
    }
    if (transactionResult.kind === 'cancelled-appointment') {
        return sendErrorResponse(res, 422, 'Un appuntamento annullato non può essere fatturato');
    }
    if (transactionResult.kind === 'waived-no-show') {
        return sendErrorResponse(
            res,
            409,
            'Il no-show è segnato come non addebitabile. Modifica prima la decisione economica.'
        );
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
            { model: InvoiceServiceScoped, as: 'services' },
            { model: InvoiceAgendaEventScoped, as: 'appointmentLinks' }
        ]
    });

    const [decoratedInvoice] = await decorateInvoicesWithPayments(schema, invoiceWithLines ? [invoiceWithLines] : []);
    return sendSuccessResponse(res, 201, decoratedInvoice, 'Invoice Created');
});

export const findAllInvoices = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped, InvoiceProductScoped, InvoiceServiceScoped, InvoiceAgendaEventScoped } = getScopedModels(schema);

    const page = Math.max(parseInt((req.query.page as string) ?? '1', 10) || 1, 1);
    const size = Math.min(Math.max(parseInt((req.query.size as string) ?? '10', 10) || 10, 1), 100);
    const paymentState = String(req.query.paymentState ?? 'all');
    const dueState = String(req.query.dueState ?? 'all');
    if (!['all', 'unpaid', 'partial', 'paid', 'void'].includes(paymentState)) {
        return sendErrorResponse(res, 400, 'Filtro stato pagamento non valido');
    }
    if (!['all', 'overdue', 'today', 'next7', 'no_due'].includes(dueState)) {
        return sendErrorResponse(res, 400, 'Filtro scadenza non valido');
    }

    const rows = await InvoiceScoped.findAll({
        // Le fatture non hanno un proprietario: l'ampiezza si eredita dai pazienti visibili.
        where: patientScopeWhere(req, schema, 'patientID'),
        include: [
            { model: InvoiceProductScoped, as: 'products' },
            { model: InvoiceServiceScoped, as: 'services' },
            { model: InvoiceAgendaEventScoped, as: 'appointmentLinks' }
        ],
        order: [['emissionDate', 'DESC']]
    });

    const allInvoices = await decorateInvoicesWithPayments(schema, rows);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
    const next7 = new Date(Date.parse(`${today}T12:00:00.000Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    const filtered = allInvoices.filter((invoice) => {
        if (paymentState !== 'all' && invoice.paymentStatus !== paymentState) return false;
        if (dueState === 'all') return true;
        if (invoice.balance <= 0 || invoice.paymentStatus === 'void') return false;
        const due = invoice.paymentTerms ? String(invoice.paymentTerms).slice(0, 10) : null;
        if (dueState === 'no_due') return !due;
        if (!due) return false;
        if (dueState === 'overdue') return due < today;
        if (dueState === 'today') return due === today;
        return due > today && due <= next7;
    });
    const aggregates = filtered.reduce(
        (totals, invoice) => {
            if (invoice.paymentStatus !== 'void') {
                const sign = invoice.documentType === 'nota_di_credito' ? -1 : 1;
                totals.billedTotal += sign * (Number(invoice.invoiceTotal) || 0);
                totals.paidAmount += Number(invoice.paidAmount) || 0;
                if (sign > 0) totals.balance += Number(invoice.balance) || 0;
            }
            return totals;
        },
        { billedTotal: 0, paidAmount: 0, balance: 0 }
    );
    Object.keys(aggregates).forEach((key) => {
        aggregates[key as keyof typeof aggregates] = Math.round(aggregates[key as keyof typeof aggregates] * 100) / 100;
    });
    const invoices = filtered.slice((page - 1) * size, page * size);
    return sendSuccessResponse(
        res,
        200,
        {
            pagination: { length: filtered.length, size, page, lastPage: Math.max(Math.ceil(filtered.length / size), 1) },
            invoices,
            aggregates
        },
        'Fatture caricate correttamente'
    );
});

export const searchInvoices = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped, InvoiceAgendaEventScoped } = getScopedModels(schema);
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
        },
        include: [{ model: InvoiceAgendaEventScoped, as: 'appointmentLinks' }]
    });

    const decoratedInvoices = await decorateInvoicesWithPayments(schema, invoices);
    return sendSuccessResponse(res, 200, decoratedInvoices, 'Ricerca completata');
});

export const findOneInvoice = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped, InvoiceProductScoped, InvoiceServiceScoped, InvoiceAgendaEventScoped } = getScopedModels(schema);

    const invoice = await InvoiceScoped.findOne({
        where: { id: req.params.invoiceId, ...patientScopeWhere(req, schema, 'patientID') },
        include: [
            { model: InvoiceProductScoped, as: 'products' },
            { model: InvoiceServiceScoped, as: 'services' },
            { model: InvoiceAgendaEventScoped, as: 'appointmentLinks' }
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

    const [decoratedInvoice] = await decorateInvoicesWithPayments(schema, [invoice]);
    if (plainInvoice.issuerIsFallback) decoratedInvoice.issuerIsFallback = true;
    if (plainInvoice.issuer) decoratedInvoice.issuer = plainInvoice.issuer;
    return sendSuccessResponse(res, 200, { invoice: decoratedInvoice }, 'Fattura caricata correttamente');
});

/**
 * Aggiorna una fattura. Se il body include `products`/`services` (anche array vuoto), le righe
 * vengono RIMPIAZZATE interamente e i totali fiscali ricalcolati (stessa logica/validazione di
 * `saveInvoice`, con prezzo/IVA sempre dal catalogo). Se non presenti, aggiorna solo i campi
 * scalari della fattura senza toccare le righe esistenti.
 */
export const updateInvoice = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const {
        InvoiceScoped,
        ProductScoped,
        ServiceScoped,
        InvoiceProductScoped,
        InvoiceServiceScoped,
        InvoicePaymentScoped
    } =
        getScopedModels(schema);
    const id = req.params.invoiceId;

    const existingInvoice = await InvoiceScoped.findOne({
        where: { id, ...patientScopeWhere(req, schema, 'patientID') }
    });
    if (!existingInvoice) {
        return sendErrorResponse(res, 404, 'Fattura non trovata');
    }
    if (String(existingInvoice.get('status') ?? '').toLowerCase() === 'void') {
        return sendErrorResponse(res, 409, 'Una fattura stornata non può più essere modificata');
    }

    const body = req.body.invoice ?? req.body;
    // Il legame con l'appuntamento nasce esclusivamente nel flusso atomico di saveInvoice:
    // consentirne la modifica con una PUT aggirerebbe lock e controllo uno-a-uno.
    const {
        products: requestedProducts,
        services: requestedServices,
        agendaEventId: _immutableAgendaEventId,
        appointments: _immutableAppointments,
        structureId: _immutableStructureId,
        paymentDate: _paymentDate,
        status: requestedStatus,
        ...invoiceFields
    } = body;
    const shouldReplaceLines = Array.isArray(requestedProducts) || Array.isArray(requestedServices);
    const postedPaidAmount = Number(await InvoicePaymentScoped.sum('amount', {
        where: { invoiceId: id, status: 'POSTED' }
    })) || 0;

    if (String(requestedStatus ?? '').toLowerCase() === 'void' && postedPaidAmount > 0) {
        return sendErrorResponse(
            res,
            409,
            'Prima di stornare la fattura devi annullare i movimenti di pagamento registrati.'
        );
    }

    // Payment state is derived from immutable movements. A direct status write is accepted only
    // for the fiscal lifecycle action `void`; paid/unpaid/partial cannot desynchronise balances.
    let updateData: Record<string, unknown> = {
        ...invoiceFields,
        ...(String(requestedStatus ?? '').toLowerCase() === 'void' ? { status: 'void' } : {})
    };

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

        if (fiscal.totals.invoiceTotal + 0.001 < postedPaidAmount) {
            return sendErrorResponse(
                res,
                409,
                'Il nuovo totale della fattura non pu\u00f2 essere inferiore agli incassi gi\u00e0 registrati.'
            );
        }

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
    const [decoratedInvoice] = await decorateInvoicesWithPayments(schema, updatedInvoice ? [updatedInvoice] : []);
    return sendSuccessResponse(res, 200, decoratedInvoice, 'Fattura aggiornata correttamente');
});

/**
 * Elimina una fattura e le sue righe collegate. In questa architettura multi-schema dinamica
 * non esistono vincoli FK/cascade a livello DB (vedi nota in cima al file): la pulizia delle
 * righe `invoice_products`/`invoice_services` va quindi fatta esplicitamente qui per evitare
 * righe orfane.
 */
export const deleteInvoice = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const { InvoiceScoped, InvoiceProductScoped, InvoiceServiceScoped, InvoicePaymentScoped, InvoiceAgendaEventScoped } = getScopedModels(schema);
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
    const linkedAppointment = await InvoiceAgendaEventScoped.findOne({
        where: { invoiceId: id },
        attributes: ['id']
    });
    if (linkedAgendaEvent || linkedAppointment) {
        return sendErrorResponse(
            res,
            409,
            'Una fattura collegata a un appuntamento effettuato non può essere eliminata. Utilizza lo storno.'
        );
    }

    const paymentCount = await InvoicePaymentScoped.count({ where: { invoiceId: id } });
    if (paymentCount > 0) {
        return sendErrorResponse(
            res,
            409,
            'Una fattura con movimenti di pagamento non può essere eliminata. Annulla i movimenti e utilizza lo storno.'
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
    findEligibleAppointments,
    findAllInvoices,
    searchInvoices,
    findOneInvoice,
    updateInvoice,
    deleteInvoice,
    exportSistemaTS
};


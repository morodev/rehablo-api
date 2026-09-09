import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { getCurrentTenantId } from '../../../middleware/auth.js';
import { getUserId, getGrantedPermissions, patientScopeWhere } from '../../../middleware/rbac.js';
import { hasPermission } from '../../auth/rbac/permissions.js';
import { getTenantSchemaName } from '../../../utils/tenantSchema.js';
import { sendInvoiceMail } from '../../../services/email.service.js';
import Tenant from '../../auth/models/tenant.model.js';
import Patient from '../../patients/models/patient.model.js';
import Invoice from '../models/invoice.model.js';
import InvoiceProduct from '../models/invoiceProduct.model.js';
import InvoiceService from '../models/invoiceService.model.js';
import { buildIssuerSnapshot } from '../utils/issuer.js';
import {
    buildPublicInvoicePayload,
    isPlausibleEmail,
    primaryPatientEmail,
    withPatientEmail
} from '../utils/invoiceShare.js';
import {
    createShareLink,
    loadUsableShareLink,
    recordShareView
} from '../services/invoiceShare.service.js';

/** Nome del documento come lo legge il paziente. */
function documentLabel(documentType: unknown): string {
    switch (`${documentType ?? ''}`) {
        case 'ricevuta_fiscale':
            return 'Ricevuta';
        case 'nota_di_credito':
            return 'Nota di credito';
        default:
            return 'Fattura';
    }
}

function documentReference(invoice: Record<string, any>): string {
    return `n. ${invoice.documentNumber} / ${invoice.documentYear}`;
}

/**
 * Carica la fattura con le righe e, se la fattura è anteriore allo snapshot dell'emittente,
 * ripiega sui dati correnti dello studio: stessa scelta di `findOneInvoice`, perché il documento
 * consegnato al paziente deve essere completo anche per lo storico.
 */
async function loadInvoiceForDocument(schema: string, invoiceId: string, tenantId: string, extraWhere = {}) {
    const invoice = await Invoice.schema(schema).findOne({
        where: { id: invoiceId, ...extraWhere },
        include: [
            { model: InvoiceProduct.schema(schema), as: 'products' },
            { model: InvoiceService.schema(schema), as: 'services' }
        ]
    });

    if (!invoice) return null;

    const plain = invoice.get({ plain: true }) as Record<string, any>;
    if (!plain.issuer) {
        const tenant = await Tenant.findByPk(tenantId);
        plain.issuer = tenant ? buildIssuerSnapshot(tenant.get({ plain: true }) as any) : null;
    }
    return plain;
}

async function loadPatient(schema: string, patientId: unknown) {
    if (!patientId) return null;
    const patient = await Patient.schema(schema).findByPk(String(patientId));
    return patient ? (patient.get({ plain: true }) as Record<string, any>) : null;
}

/**
 * Emette il link da consegnare al paziente. Non invia nulla: serve al canale WhatsApp, dove è
 * l'operatore a premere Invia dal proprio telefono, e a chi vuole semplicemente copiare l'URL.
 */
export const createInvoiceShareLink = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const tenantId = getCurrentTenantId(req);

    const invoice = await Invoice.schema(schema).findOne({
        where: { id: req.params.invoiceId, ...patientScopeWhere(req, schema, 'patientID') }
    });
    if (!invoice) {
        return sendErrorResponse(res, 404, 'Fattura non trovata');
    }

    const channel = req.body?.channel === 'whatsapp' ? 'whatsapp' : 'link';
    const share = await createShareLink({
        tenantId,
        invoiceId: invoice.get('id') as string,
        patientId: (invoice.get('patientID') as string) ?? null,
        createdByUserId: getUserId(req),
        channel
    });

    return sendSuccessResponse(
        res,
        201,
        { url: share.url, expiresAt: share.expiresAt },
        'Link generato correttamente'
    );
});

/**
 * Invia la fattura per email.
 *
 * Se l'anagrafica non ha un indirizzo, il chiamante può passarne uno: viene salvato sul paziente,
 * così la volta dopo l'operatore non deve richiederlo. Il salvataggio avviene PRIMA dell'invio di
 * proposito — un indirizzo raccolto e poi perso perché l'SMTP era irraggiungibile è il modo più
 * facile per far ridigitare tutto all'operatore.
 */
export const sendInvoiceByEmail = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const tenantId = getCurrentTenantId(req);

    const invoiceRecord = await Invoice.schema(schema).findOne({
        where: { id: req.params.invoiceId, ...patientScopeWhere(req, schema, 'patientID') }
    });
    if (!invoiceRecord) {
        return sendErrorResponse(res, 404, 'Fattura non trovata');
    }

    const invoice = invoiceRecord.get({ plain: true }) as Record<string, any>;
    const patientRecord = invoice.patientID
        ? await Patient.schema(schema).findByPk(String(invoice.patientID))
        : null;
    const patient = patientRecord ? (patientRecord.get({ plain: true }) as Record<string, any>) : null;

    const requestedEmail = `${req.body?.email ?? ''}`.trim();
    if (requestedEmail && !isPlausibleEmail(requestedEmail)) {
        return sendErrorResponse(res, 400, 'Indirizzo email non valido');
    }

    const recipient = requestedEmail || primaryPatientEmail(patient?.emails);
    if (!recipient) {
        return sendErrorResponse(res, 422, 'Il paziente non ha un indirizzo email: indicane uno');
    }

    let emailSaved = false;
    // L'operatore può inviare a un indirizzo occasionale (un familiare, il commercialista) senza
    // che diventi il recapito del paziente: in quel caso il client chiede esplicitamente di non
    // salvarlo. L'assenza del flag vale come consenso, così il caso normale resta una sola scelta.
    const shouldSave = req.body?.saveToPatient !== false;
    // Poter inviare una fattura non implica poter riscrivere l'anagrafica: chi non ha
    // `patient:update` invia lo stesso, ma l'indirizzo non viene memorizzato.
    const canUpdatePatient = hasPermission(getGrantedPermissions(req), 'patient', 'update');
    if (requestedEmail && shouldSave && patientRecord && canUpdatePatient) {
        const emails = withPatientEmail(patient?.emails, requestedEmail);
        if (emails) {
            await patientRecord.update({ emails });
            emailSaved = true;
        }
    }

    const tenant = await Tenant.findByPk(tenantId);
    const centerName = `${tenant?.get('businessName') ?? ''}`.trim() || 'Il tuo centro';

    const share = await createShareLink({
        tenantId,
        invoiceId: invoice.id,
        patientId: invoice.patientID ?? null,
        createdByUserId: getUserId(req),
        channel: 'email'
    });

    try {
        await sendInvoiceMail({
            to: recipient,
            link: share.url,
            centerName,
            documentLabel: documentLabel(invoice.documentType),
            documentReference: documentReference(invoice),
            patientName: patient ? [patient.name, patient.surname].filter(Boolean).join(' ') : null,
            expiresAt: share.expiresAt
        });
    } catch (err) {
        console.error('[invoiceShare] invio email fallito', err);
        return sendErrorResponse(
            res,
            502,
            "Il documento è pronto ma l'email non è partita. Riprova o condividi il link."
        );
    }

    return sendSuccessResponse(
        res,
        200,
        { email: recipient, emailSaved, url: share.url, expiresAt: share.expiresAt },
        'Documento inviato correttamente'
    );
});

/**
 * Apertura del link da parte del paziente: nessuna autenticazione.
 *
 * Il token è l'unica credenziale, quindi la risposta è deliberatamente avara: solo i campi del
 * documento (vedi `buildPublicInvoicePayload`) e un errore identico per token inesistente, scaduto
 * o revocato, per non confermare l'esistenza di una fattura a chi tira a indovinare.
 */
export const getPublicInvoice = asyncHandler(async (req: Request, res: Response) => {
    const link = await loadUsableShareLink(`${req.params.token ?? ''}`);
    if (!link) {
        return sendErrorResponse(res, 404, 'Link non valido o scaduto');
    }

    const tenantId = link.get('tenantId') as string;
    const schema = getTenantSchemaName(tenantId);

    const invoice = await loadInvoiceForDocument(schema, link.get('invoiceId') as string, tenantId);
    if (!invoice) {
        return sendErrorResponse(res, 404, 'Link non valido o scaduto');
    }

    const patient = await loadPatient(schema, invoice.patientID);
    await recordShareView(link);

    const tenant = await Tenant.findByPk(tenantId);
    return sendSuccessResponse(
        res,
        200,
        {
            invoice: buildPublicInvoicePayload(invoice, patient),
            centerName: `${tenant?.get('businessName') ?? ''}`.trim() || null
        },
        'Documento caricato correttamente'
    );
});

export default { createInvoiceShareLink, sendInvoiceByEmail, getPublicInvoice };

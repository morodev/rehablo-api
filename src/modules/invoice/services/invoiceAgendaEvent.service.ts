import { Op } from 'sequelize';
import InvoiceAgendaEvent from '../models/invoiceAgendaEvent.model.js';

export interface InvoiceAgendaLink {
    invoiceId: string;
    agendaEventId: string;
    serviceId: string | null;
}

export async function getInvoiceAgendaLinksByEventIds(
    schema: string,
    agendaEventIds: string[]
): Promise<InvoiceAgendaLink[]> {
    if (agendaEventIds.length === 0) return [];
    const rows = await InvoiceAgendaEvent.schema(schema).findAll({
        where: { agendaEventId: { [Op.in]: agendaEventIds }, releasedAt: null },
        attributes: ['invoiceId', 'agendaEventId', 'serviceId']
    });
    return rows.map((row) => row.get({ plain: true }) as InvoiceAgendaLink);
}

export async function getInvoiceAgendaLinksByInvoiceIds(
    schema: string,
    invoiceIds: string[]
): Promise<InvoiceAgendaLink[]> {
    if (invoiceIds.length === 0) return [];
    const rows = await InvoiceAgendaEvent.schema(schema).findAll({
        where: { invoiceId: { [Op.in]: invoiceIds }, releasedAt: null },
        attributes: ['invoiceId', 'agendaEventId', 'serviceId']
    });
    return rows.map((row) => row.get({ plain: true }) as InvoiceAgendaLink);
}

export async function getLinkedInvoiceId(
    schema: string,
    agendaEventId: string,
    legacyInvoiceId?: string | null
): Promise<string | null> {
    if (legacyInvoiceId) return legacyInvoiceId;
    const row = await InvoiceAgendaEvent.schema(schema).findOne({
        where: { agendaEventId, releasedAt: null },
        attributes: ['invoiceId']
    });
    return (row?.get('invoiceId') as string | undefined) ?? null;
}

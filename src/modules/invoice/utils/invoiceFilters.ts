const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Normalizza il filtro mese dell'elenco fatture.
 *
 * Restituisce `''` quando il filtro è assente (nessuna restrizione) e `null` quando il valore
 * ricevuto non è un mese valido: il chiamante distingue così il "mostra tutto" dall'input da
 * rifiutare con 400, invece di degradare silenziosamente a nessun filtro.
 */
export function parseInvoiceMonthFilter(value: unknown): string | null {
    const candidate = String(value ?? '').trim();
    if (!candidate || candidate === 'all') {
        return '';
    }
    return MONTH_KEY_PATTERN.test(candidate) ? candidate : null;
}

/** Il mese di competenza di una fattura è quello di emissione, coerente con il report fatturato. */
export function invoiceEmissionMonth(emissionDate: unknown): string {
    return String(emissionDate ?? '').slice(0, 7);
}

/** Il mese di incasso viene sempre dalla data del movimento, mai dalla data della fattura. */
export function invoicePaymentMonth(paidAt: unknown): string {
    return String(paidAt ?? '').slice(0, 7);
}

/** Whitelisted SQL ordering shared by all pages of the invoice list. */
export function invoiceListOrder(sort: unknown = 'date', direction: unknown = 'desc'): import('sequelize').Order | null {
    if (sort !== 'date' && sort !== 'document' || direction !== 'asc' && direction !== 'desc') return null;
    const selectedDirection = direction === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS LAST';
    return sort === 'document'
        ? [['documentYear', selectedDirection], ['documentNumber', selectedDirection], ['emissionDate', 'DESC NULLS LAST'], ['id', 'ASC']]
        : [['emissionDate', selectedDirection], ['documentYear', 'DESC NULLS LAST'], ['documentNumber', 'DESC NULLS LAST'], ['id', 'ASC']];
}

/**
 * Computes invoice totals (selling price, discounted price, VAT, INPS "rivalsa", net amount due).
 * Ported from the former rehablo-invoice (v2) service, which had the most complete fiscal logic
 * among the two former invoicing microservices.
 *
 * FIX rispetto alla versione originale (bug corretti):
 * - I `services` venivano completamente ignorati nel calcolo: una fattura con soli servizi
 *   (il caso più comune per un fisioterapista: la prestazione È un "servizio") risultava con
 *   `invoiceTotal`/`invoiceVAT`/`sellingPrice` tutti a 0.
 * - La `quantity` di ogni riga non veniva mai applicata al prezzo: una riga con quantity=3 veniva
 *   conteggiata come se fosse quantity=1.
 * - I codici IVA venivano confrontati come numeri (4|5|10|22), ma il catalogo (`Product`/`Service`)
 *   memorizza `productVat` come stringa (per poter rappresentare anche la natura di esenzione,
 *   es. "N4" per le prestazioni sanitarie esenti ex art. 10 DPR 633/72): qualunque riga esente
 *   finiva silenziosamente nel ramo di warning, contribuendo comunque 0 all'IVA totale (risultato
 *   numericamente corretto ma non esplicitamente gestito/documentato).
 */

/** Aliquote IVA "standard" gestite esplicitamente. Qualunque altro codice (es. "N4", "ESENTE",
 *  "0", assente) viene trattato come operazione esente/non imponibile (0%). */
const STANDARD_VAT_RATES = ['4', '5', '10', '22'];

export interface InvoiceLineInput {
    /** Prezzo UNITARIO di riga (dal catalogo Product/Service, non dal client: vedi invoice.controller.ts). */
    sellingPrice: number;
    /** Quantità della riga (default 1 se assente). */
    quantity?: number | null;
    /** Aliquota IVA standard come stringa ("4"|"5"|"10"|"22") oppure natura di esenzione (es. "N4"). */
    productVat: string | number | null | undefined;
}

export interface EvalTotalsInput {
    products?: InvoiceLineInput[];
    services?: InvoiceLineInput[];
    discountType?: 'percentage' | 'value';
    discountAmount?: number;
    isRivals?: boolean;
    rivals?: number;
    isCashPro?: boolean;
    isTaxWithholding?: boolean;
    taxWithholding?: number;
    /**
     * false quando il REGIME dell'emittente esclude l'IVA (forfettario RF19, minimi RF02):
     * in quel caso nessuna riga espone IVA, nemmeno la vendita di un prodotto con aliquota 22%
     * a catalogo. Vedi utils/fiscalRegime.ts. Default: true (regime ordinario).
     */
    appliesVat?: boolean;
    isStamp?: boolean;
    stampAmount?: number;
    /** true se il bollo è riaddebitato al paziente e quindi sommato al totale (art. 15 DPR 633/72). */
    stampChargedToPatient?: boolean;
}

export interface EvalTotalsResult {
    invoiceTotal: number;
    sellingPrice: number;
    discSellingPrice: number;
    invoiceNet: number;
    invoiceVAT: number;
    /**
     * Imponibile delle sole righe SENZA IVA (esenti/non soggette), già scontato.
     * È la base su cui si verifica la soglia di 77,47 € della marca da bollo: su una fattura mista
     * il bollo dipende da questa quota, non dal totale del documento.
     */
    vatFreeAmount: number;
    /** Contributo previdenziale addebitato (rivalsa INPS o contributo integrativo cassa). */
    rivalsAmount: number;
    /** Ritenuta d'acconto trattenuta dal committente. */
    taxWithholdingAmount: number;
    /**
     * Bollo effettivamente sommato al totale (0 se non applicato o non riaddebitato).
     * Deliberatamente NON si chiama `stampAmount`: quello è il campo del documento (l'importo del
     * tributo, es. 2,00 €) e non deve essere sovrascritto dal risultato del calcolo.
     */
    stampChargedAmount: number;
}

/** Normalizza un codice IVA in una delle chiavi note ('4'|'5'|'10'|'22'|'ESENTE'). Codici non
 *  riconosciuti vengono trattati come esenti (0%, la scelta più prudente per non applicare
 *  un'IVA non intenzionale) ma segnalati con un warning, per far emergere dati di catalogo sporchi. */
function normalizeVatRateKey(rawVat: string | number | null | undefined): string {
    const value = `${rawVat ?? ''}`.trim().toUpperCase();
    if (STANDARD_VAT_RATES.includes(value)) return value;
    if (value === '' || value === '0' || value === 'N4' || value === 'ESENTE' || value === 'ES') return 'ESENTE';
    console.warn(`[evalTotals] codice IVA non riconosciuto "${rawVat}": trattato come esente (0%). Verificare il catalogo prodotti/servizi.`);
    return 'ESENTE';
}

function getPercDiscount(discountType: string | undefined, discountAmount: number, totalSellingPrice: number): number {
    if (discountType === 'percentage') return discountAmount;
    if (discountType === 'value') return totalSellingPrice ? (discountAmount * 100) / totalSellingPrice : 0;
    return 0;
}

function applyDiscount(discount: number, sellingPrice: number): number {
    return (discount * sellingPrice) / 100;
}

function evalVat(isRivals: boolean, rivals: number, vatRate: number, sellingPrice: number): number {
    if (isRivals) {
        return (vatRate / 100) * (sellingPrice + (sellingPrice * rivals) / 100);
    }
    return (vatRate / 100) * sellingPrice;
}

export function evalTotals(invoiceFields: EvalTotalsInput): EvalTotalsResult {
    const rivals = invoiceFields.rivals || 0;
    const isRivals = !!invoiceFields.isRivals;
    // Il regime dell'emittente ha la precedenza sull'aliquota di catalogo: un forfettario non
    // addebita IVA nemmeno vendendo un prodotto con aliquota 22% censita a catalogo.
    const appliesVat = invoiceFields.appliesVat !== false;

    // Unifica prodotti e servizi in un'unica lista di righe, applicando la quantità al prezzo
    // unitario (fix del bug "quantity ignorata").
    const lines = [...(invoiceFields.products ?? []), ...(invoiceFields.services ?? [])].map((line) => ({
        totalLinePrice: line.sellingPrice * (line.quantity ?? 1),
        vatKey: appliesVat ? normalizeVatRateKey(line.productVat) : 'ESENTE'
    }));

    let totalSellingPrice = 0;
    lines.forEach((line) => {
        totalSellingPrice += line.totalLinePrice;
    });

    const discount = getPercDiscount(invoiceFields.discountType, invoiceFields.discountAmount || 0, totalSellingPrice);
    const totalDiscSellingPrice = totalSellingPrice - applyDiscount(discount, totalSellingPrice);

    let totalRivals = 0;
    let vatFreeAmount = 0;
    const vatBuckets: Record<string, number> = { '4': 0, '5': 0, '10': 0, '22': 0, ESENTE: 0 };

    lines.forEach((line) => {
        totalRivals += (rivals * line.totalLinePrice) / 100;
        const discountedPrice = line.totalLinePrice - applyDiscount(discount, line.totalLinePrice);

        if (line.vatKey === 'ESENTE') {
            vatBuckets.ESENTE += 0; // operazione esente/non imponibile: nessuna IVA dovuta.
            vatFreeAmount += discountedPrice; // ...ma concorre alla soglia della marca da bollo.
        } else {
            vatBuckets[line.vatKey] += evalVat(isRivals, rivals, Number(line.vatKey), discountedPrice);
        }
    });

    const totalProductVat = vatBuckets['4'] + vatBuckets['5'] + vatBuckets['10'] + vatBuckets['22'] + vatBuckets.ESENTE;

    // Marca da bollo: il tributo è dovuto dall'emittente, ma entra nel totale a pagare SOLO se
    // riaddebitato al cliente (art. 15, c. 1, n. 3, DPR 633/72, che lo esclude dalla base imponibile).
    const stampChargedAmount =
        invoiceFields.isStamp && invoiceFields.stampChargedToPatient ? invoiceFields.stampAmount || 0 : 0;

    const invoiceTotal = totalDiscSellingPrice + totalRivals + totalProductVat + stampChargedAmount;

    let taxWithholdingValue = 0;
    if (invoiceFields.isTaxWithholding) {
        const taxWithholding = invoiceFields.taxWithholding || 0;
        taxWithholdingValue = invoiceFields.isCashPro
            ? (totalSellingPrice * taxWithholding) / 100
            : ((totalSellingPrice + totalRivals) * taxWithholding) / 100;
    }

    const netAmountDue = invoiceTotal - taxWithholdingValue;

    return {
        invoiceTotal,
        sellingPrice: totalSellingPrice,
        discSellingPrice: totalDiscSellingPrice,
        invoiceNet: netAmountDue,
        invoiceVAT: totalProductVat,
        vatFreeAmount,
        rivalsAmount: totalRivals,
        taxWithholdingAmount: taxWithholdingValue,
        stampChargedAmount
    };
}

/**
 * Sottoinsieme dei totali che corrisponde a colonne di `invoices`.
 *
 * Serve a poter fare `create({ ...invoiceFields, ...toPersistedTotals(totals) })` senza che i
 * valori di supporto (soglia bollo, importi di dettaglio) finiscano per collidere con campi
 * omonimi del documento.
 */
export function toPersistedTotals(totals: EvalTotalsResult) {
    return {
        invoiceTotal: totals.invoiceTotal,
        sellingPrice: totals.sellingPrice,
        discSellingPrice: totals.discSellingPrice,
        invoiceNet: totals.invoiceNet,
        invoiceVAT: totals.invoiceVAT
    };
}




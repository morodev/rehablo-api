/**
 * Adapter FSE di default: NON esegue alcuna trasmissione reale.
 *
 * Viene usato finché lo studio/tenant non ha completato l'accreditamento presso l'infrastruttura
 * di interoperabilità della propria Regione. Restituisce sempre un esito "non configurato" invece
 * di fallire silenziosamente o di fingere un invio andato a buon fine: è una scelta deliberata per
 * evitare falsi positivi su un adempimento legale.
 */
import { FseAdapter, FseClinicalDocument, FseConsentStatus, FseFeedResult } from './fseAdapter.interface.js';

export class NullFseAdapter implements FseAdapter {
    constructor(private readonly regionCode?: string | null) {}

    async feedDocument(document: FseClinicalDocument): Promise<FseFeedResult> {
        console.warn(
            `[FSE] Nessun adapter regionale configurato per la Regione "${this.regionCode ?? 'sconosciuta'}": ` +
                `documento "${document.title}" per il paziente ${document.patientFiscalCode} NON è stato ` +
                'trasmesso al Fascicolo Sanitario Elettronico. Registrare un adapter concreto per questa ' +
                'Regione nel registry di `getFseAdapter()` una volta ottenuto l\'accreditamento.'
        );
        return {
            success: false,
            message: `FSE adapter non configurato per la Regione "${this.regionCode ?? 'sconosciuta'}": nessun invio effettuato.`
        };
    }

    async getConsentStatus(_patientFiscalCode: string): Promise<FseConsentStatus> {
        return 'NON_RICHIESTO';
    }
}

/**
 * Registry degli adapter regionali concreti, disponibile per ogni Regione via il suo codice
 * ISTAT/nome normalizzato (`Structure.region`). VUOTO finché non viene ottenuto un accreditamento
 * e implementato un adapter reale (es. `registerFseAdapter('LOMBARDIA', () => new LombardiaFseAdapter())`).
 *
 * IMPORTANTE: in un contesto multi-tenant dove ogni tenant può avere più `Structure` anche in
 * Regioni diverse, l'adapter NON va selezionato una volta per tenant, ma per OGNI singolo atto
 * clinico/documento, risalendo alla Regione della `Structure` in cui è stato erogato (vedi
 * `regionResolver.ts` in questo stesso modulo per la funzione di risoluzione).
 */
const regionAdapterFactories = new Map<string, () => FseAdapter>();

export function registerFseAdapter(regionCode: string, factory: () => FseAdapter): void {
    regionAdapterFactories.set(regionCode.toUpperCase(), factory);
}

/**
 * Restituisce l'adapter FSE da usare per una specifica Regione (quella della `Structure` in cui
 * è stato erogato il documento clinico, NON quella "di default" del tenant). Se per quella
 * Regione non è ancora stato registrato un adapter concreto, ricade su `NullFseAdapter`.
 */
export function getFseAdapter(regionCode?: string | null): FseAdapter {
    if (!regionCode) {
        return new NullFseAdapter(regionCode);
    }
    const factory = regionAdapterFactories.get(regionCode.toUpperCase());
    return factory ? factory() : new NullFseAdapter(regionCode);
}



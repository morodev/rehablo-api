/**
 * Regime fiscale del soggetto emittente e regole che ne derivano in fatturazione.
 *
 * Il regime fiscale NON è un dato anagrafico decorativo: determina se in fattura si espone l'IVA,
 * quale "natura" indicare al suo posto, se è ammessa la ritenuta d'acconto e quali diciture sono
 * obbligatorie sul documento. Senza questo dato il software può solo indovinare, e un documento
 * fiscalmente sbagliato è già in mano al paziente.
 *
 * Riferimenti (dettaglio completo in docs/REGIME_FISCALE_IT.md):
 * - Specifiche tecniche FatturaPA, tabella `RegimeFiscale` (1.2.1.8): codici RF01-RF19.
 * - L. 190/2014 art. 1 commi 54-89 (forfettario) e comma 67 (nessuna ritenuta d'acconto).
 * - DPR 633/72 art. 10 n. 18 (prestazioni sanitarie esenti IVA) -> natura N4.
 * - DPR 642/72 Tariffa Parte I art. 13 (marca da bollo 2,00 € oltre 77,47 € su documenti senza IVA).
 * - DPR 633/72 art. 15 c. 1 n. 3 (il bollo riaddebitato è escluso dalla base imponibile).
 *
 * NB: il software è oggi destinato al solo mercato italiano. Se in futuro servisse un altro Paese,
 * questo modulo è il punto in cui isolare la fiscalità nazionale.
 */

/** Codici della tabella `RegimeFiscale` FatturaPA. */
export type TaxRegimeCode =
    | 'RF01' | 'RF02' | 'RF04' | 'RF05' | 'RF06' | 'RF07' | 'RF08' | 'RF09' | 'RF10'
    | 'RF11' | 'RF12' | 'RF13' | 'RF14' | 'RF15' | 'RF16' | 'RF17' | 'RF18' | 'RF19';

export interface TaxRegimeDefinition {
    code: TaxRegimeCode;
    label: string;
    /** true se il soggetto addebita l'IVA in fattura secondo l'aliquota di riga. */
    appliesVat: boolean;
    /**
     * Natura IVA imposta dal regime, che PREVALE su quella di riga.
     * Il forfettario è "non soggetto" per effetto del regime (N2.2): questo assorbe anche
     * l'esenzione art. 10 delle prestazioni sanitarie, che quindi NON va indicata come N4.
     */
    forcedVatNature: string | null;
    /** false quando il regime esclude per legge la ritenuta d'acconto (art. 1 c. 67 L. 190/2014). */
    allowsWithholding: boolean;
    /** Diciture da riportare obbligatoriamente sul documento per effetto del regime. */
    notes: string[];
    /** true per i regimi realisticamente usati nel settore sanitario/riabilitativo: la UI li mostra per primi. */
    common: boolean;
}

/** Natura IVA delle prestazioni sanitarie esenti (art. 10 n. 18 DPR 633/72). */
export const HEALTHCARE_VAT_NATURE = 'N4';

/** Natura IVA delle operazioni non soggette per effetto del regime (forfettario/minimi). */
export const NOT_SUBJECT_VAT_NATURE = 'N2.2';

/** Soglia oltre la quale è dovuta la marca da bollo su documenti senza IVA (DPR 642/72). */
export const STAMP_DUTY_THRESHOLD = 77.47;

/** Importo dell'imposta di bollo assolta in modo virtuale sulle fatture. */
export const DEFAULT_STAMP_DUTY_AMOUNT = 2;

const EXEMPT_ART10_NOTE = 'Operazione esente da IVA ai sensi dell\'art. 10, n. 18, DPR 633/1972';

const FORFETTARIO_NOTES = [
    'Operazione effettuata ai sensi dell\'art. 1, commi 54-89, della Legge n. 190/2014 e successive modificazioni/integrazioni',
    'Operazione non soggetta a ritenuta d\'acconto ai sensi dell\'art. 1, comma 67, della Legge n. 190/2014'
];

/**
 * Catalogo completo dei regimi. È volutamente completo (RF01-RF19) e non ridotto ai soli casi
 * sanitari: il codice finisce tale e quale nell'XML della fattura elettronica per le righe non
 * sanitarie, quindi limitare l'elenco significherebbe impedire a uno studio di fatturare.
 */
export const TAX_REGIMES: TaxRegimeDefinition[] = [
    {
        code: 'RF01',
        label: 'RF01 - Ordinario',
        appliesVat: true,
        forcedVatNature: null,
        allowsWithholding: true,
        notes: [],
        common: true
    },
    {
        code: 'RF02',
        label: 'RF02 - Contribuenti minimi (art. 1, c. 96-117, L. 244/2007)',
        appliesVat: false,
        forcedVatNature: NOT_SUBJECT_VAT_NATURE,
        allowsWithholding: false,
        notes: ['Operazione effettuata ai sensi dell\'art. 1, commi 96-117, della Legge n. 244/2007'],
        common: true
    },
    { code: 'RF04', label: 'RF04 - Agricoltura e attività connesse e pesca', appliesVat: true, forcedVatNature: null, allowsWithholding: true, notes: [], common: false },
    { code: 'RF05', label: 'RF05 - Vendita sali e tabacchi', appliesVat: true, forcedVatNature: null, allowsWithholding: true, notes: [], common: false },
    { code: 'RF06', label: 'RF06 - Commercio dei fiammiferi', appliesVat: true, forcedVatNature: null, allowsWithholding: true, notes: [], common: false },
    { code: 'RF07', label: 'RF07 - Editoria', appliesVat: true, forcedVatNature: null, allowsWithholding: true, notes: [], common: false },
    { code: 'RF08', label: 'RF08 - Gestione di servizi di telefonia pubblica', appliesVat: true, forcedVatNature: null, allowsWithholding: true, notes: [], common: false },
    { code: 'RF09', label: 'RF09 - Rivendita di documenti di trasporto pubblico e di sosta', appliesVat: true, forcedVatNature: null, allowsWithholding: true, notes: [], common: false },
    { code: 'RF10', label: 'RF10 - Intrattenimenti, giochi e altre attività (DPR 640/72)', appliesVat: true, forcedVatNature: null, allowsWithholding: true, notes: [], common: false },
    { code: 'RF11', label: 'RF11 - Agenzie di viaggi e turismo (art. 74-ter DPR 633/72)', appliesVat: true, forcedVatNature: null, allowsWithholding: true, notes: [], common: false },
    { code: 'RF12', label: 'RF12 - Agriturismo', appliesVat: true, forcedVatNature: null, allowsWithholding: true, notes: [], common: false },
    { code: 'RF13', label: 'RF13 - Vendite a domicilio', appliesVat: true, forcedVatNature: null, allowsWithholding: true, notes: [], common: false },
    { code: 'RF14', label: 'RF14 - Rivendita di beni usati, oggetti d\'arte, d\'antiquariato o da collezione', appliesVat: true, forcedVatNature: null, allowsWithholding: true, notes: [], common: false },
    { code: 'RF15', label: 'RF15 - Agenzie di vendite all\'asta di oggetti d\'arte, antiquariato o da collezione', appliesVat: true, forcedVatNature: null, allowsWithholding: true, notes: [], common: false },
    {
        code: 'RF16',
        label: 'RF16 - IVA per cassa P.A. (art. 6, c. 5, DPR 633/72)',
        appliesVat: true,
        forcedVatNature: null,
        allowsWithholding: true,
        notes: ['IVA ad esigibilità differita ai sensi dell\'art. 6, comma 5, DPR 633/1972'],
        common: true
    },
    {
        code: 'RF17',
        label: 'RF17 - IVA per cassa (art. 32-bis DL 83/2012)',
        appliesVat: true,
        forcedVatNature: null,
        allowsWithholding: true,
        notes: ['IVA per cassa ai sensi dell\'art. 32-bis del DL 22 giugno 2012, n. 83'],
        common: true
    },
    {
        code: 'RF18',
        label: 'RF18 - Altro',
        appliesVat: true,
        forcedVatNature: null,
        allowsWithholding: true,
        notes: [],
        common: true
    },
    {
        code: 'RF19',
        label: 'RF19 - Regime forfettario (art. 1, c. 54-89, L. 190/2014)',
        appliesVat: false,
        forcedVatNature: NOT_SUBJECT_VAT_NATURE,
        allowsWithholding: false,
        notes: FORFETTARIO_NOTES,
        common: true
    }
];

export const DEFAULT_TAX_REGIME: TaxRegimeCode = 'RF01';

const REGIME_BY_CODE = new Map<string, TaxRegimeDefinition>(TAX_REGIMES.map((regime) => [regime.code, regime]));

export function isTaxRegimeCode(value: unknown): value is TaxRegimeCode {
    return typeof value === 'string' && REGIME_BY_CODE.has(value.trim().toUpperCase());
}

/** Definizione del regime, con ripiego sull'ordinario per valori assenti o non riconosciuti. */
export function getTaxRegime(code: string | null | undefined): TaxRegimeDefinition {
    const normalized = `${code ?? ''}`.trim().toUpperCase();
    return REGIME_BY_CODE.get(normalized) ?? REGIME_BY_CODE.get(DEFAULT_TAX_REGIME)!;
}

/** Cassa previdenziale di riferimento: cambia il trattamento del contributo addebitato in fattura. */
export type SocialSecurityFund = 'NONE' | 'INPS_GS' | 'CASSA';

/**
 * Impostazioni fiscali del tenant necessarie a costruire il profilo. È un sottoinsieme di
 * `TenantAttributes`: tenerlo separato evita che questo modulo dipenda dal modello Sequelize.
 */
export interface TenantFiscalSettings {
    taxRegime?: string | null;
    socialSecurityFund?: string | null;
    socialSecurityRate?: number | string | null;
    withholdingRate?: number | string | null;
    stampDutyAmount?: number | string | null;
    stampChargedToPatient?: boolean | null;
}

/** Regole di fatturazione effettivamente applicabili allo studio, già risolte. */
export interface FiscalProfile {
    taxRegime: TaxRegimeCode;
    taxRegimeLabel: string;
    /** false = nessuna IVA in fattura, per nessuna riga (forfettario/minimi). */
    appliesVat: boolean;
    /** Natura IVA imposta dal regime; se valorizzata prevale su quella delle righe. */
    forcedVatNature: string | null;
    /** Natura IVA proposta di default (regime, altrimenti esenzione sanitaria art. 10 n. 18). */
    defaultVatNature: string;
    allowsWithholding: boolean;
    withholdingRate: number;
    socialSecurityFund: SocialSecurityFund;
    socialSecurityRate: number;
    /**
     * true quando il contributo previdenziale addebitato è ESCLUSO dalla base della ritenuta
     * d'acconto (contributo integrativo delle casse professionali). La rivalsa INPS 4% della
     * Gestione Separata, invece, concorre al reddito ed è soggetta a ritenuta.
     */
    socialSecurityExcludedFromWithholding: boolean;
    stampDutyAmount: number;
    stampDutyThreshold: number;
    stampChargedToPatient: boolean;
    /** Diciture obbligatorie derivanti dal solo regime (le altre dipendono dal documento). */
    notes: string[];
}

const toNumber = (value: unknown, fallback: number): number => {
    const parsed = typeof value === 'number' ? value : parseFloat(`${value ?? ''}`);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const toFund = (value: unknown): SocialSecurityFund => {
    const normalized = `${value ?? ''}`.trim().toUpperCase();
    return normalized === 'INPS_GS' || normalized === 'CASSA' ? normalized : 'NONE';
};

/** Risolve le regole di fatturazione a partire dai dati aziendali dello studio. */
export function resolveFiscalProfile(tenant: TenantFiscalSettings | null | undefined): FiscalProfile {
    const regime = getTaxRegime(tenant?.taxRegime);
    const fund = toFund(tenant?.socialSecurityFund);

    return {
        taxRegime: regime.code,
        taxRegimeLabel: regime.label,
        appliesVat: regime.appliesVat,
        forcedVatNature: regime.forcedVatNature,
        defaultVatNature: regime.forcedVatNature ?? HEALTHCARE_VAT_NATURE,
        allowsWithholding: regime.allowsWithholding,
        withholdingRate: toNumber(tenant?.withholdingRate, 20),
        socialSecurityFund: fund,
        socialSecurityRate: toNumber(tenant?.socialSecurityRate, 4),
        socialSecurityExcludedFromWithholding: fund === 'CASSA',
        stampDutyAmount: toNumber(tenant?.stampDutyAmount, DEFAULT_STAMP_DUTY_AMOUNT),
        stampDutyThreshold: STAMP_DUTY_THRESHOLD,
        stampChargedToPatient: tenant?.stampChargedToPatient !== false,
        notes: [...regime.notes]
    };
}

/**
 * Dice se è dovuta la marca da bollo.
 *
 * Il presupposto è il documento SENZA IVA di importo superiore a 77,47 €: su una fattura mista
 * (righe sanitarie esenti + vendita di un tutore con IVA 22%) la soglia va verificata sulla sola
 * quota senza IVA, non sul totale del documento.
 */
export function isStampDutyDue(vatFreeAmount: number, profile: FiscalProfile): boolean {
    return vatFreeAmount > profile.stampDutyThreshold;
}

export interface FiscalNotesInput {
    profile: FiscalProfile;
    /** true se il documento contiene almeno una riga senza IVA. */
    hasVatFreeLines: boolean;
    /** true se sul documento è applicata la marca da bollo. */
    hasStampDuty: boolean;
}

/**
 * Diciture da stampare sul documento. Vengono congelate sulla fattura (come `issuer`) perché un
 * documento del 2025 emesso in forfettario deve continuare a riportare le diciture del forfettario
 * anche dopo il passaggio dello studio al regime ordinario.
 */
export function buildFiscalNotes({ profile, hasVatFreeLines, hasStampDuty }: FiscalNotesInput): string[] {
    const notes = [...profile.notes];

    // L'esenzione art. 10 si cita solo quando NON c'è già una natura imposta dal regime: per un
    // forfettario l'operazione è "non soggetta" (N2.2), non "esente", e citare l'art. 10 sarebbe
    // una contraddizione in fattura.
    if (!profile.forcedVatNature && hasVatFreeLines) {
        notes.push(EXEMPT_ART10_NOTE);
    }

    if (hasStampDuty) {
        notes.push(
            `Imposta di bollo di € ${profile.stampDutyAmount.toFixed(2)} assolta in modo virtuale` +
                (profile.stampChargedToPatient
                    ? ' e addebitata al cliente ai sensi dell\'art. 15, c. 1, n. 3, DPR 633/1972'
                    : '')
        );
    }

    return notes;
}


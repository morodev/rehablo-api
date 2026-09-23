/** Sistema TS: DM 18 luglio 2023, Allegato A, paragrafi 2.2, 2.4 e 2.16.
 * Il profilo è dichiarato dall'emittente, mai dedotto da regime fiscale o abbonamento.
 */
export const STS_EXPENSE_CODES = {
    PHYSIOTHERAPIST: ['SP'],
    ACCREDITED_STRUCTURE: ['TK', 'SR', 'CT', 'PI', 'IC', 'AA'],
    AUTHORIZED_STRUCTURE: ['SR', 'CT', 'PI', 'IC', 'AA']
} as const;
export type StsIssuerType = keyof typeof STS_EXPENSE_CODES;
export interface StsFiscalSettings {
    stsIssuerType: StsIssuerType | null;
    stsDefaultExpenseTypeCode: string | null;
}
type Data = Record<string, any>;
const clean = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null;
export const isStsIssuerType = (value: unknown): value is StsIssuerType =>
    typeof value === 'string' && Object.hasOwn(STS_EXPENSE_CODES, value);
export const isStsExpenseCode = (profile: StsIssuerType, code: string): boolean =>
    (STS_EXPENSE_CODES[profile] as readonly string[]).includes(code);
const fail = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 400 }); };

export function getStsFiscalSettings(tenant: Data | null | undefined): StsFiscalSettings {
    const value = tenant?.administrationSettings?.fiscal ?? {};
    const profile = isStsIssuerType(value.stsIssuerType) ? value.stsIssuerType : null;
    const code = clean(value.stsDefaultExpenseTypeCode);
    return { stsIssuerType: profile, stsDefaultExpenseTypeCode: profile === 'PHYSIOTHERAPIST' ? 'SP'
        : profile && code && isStsExpenseCode(profile, code) ? code : null };
}

export function validateStsFiscalSettings(source: Data, current: StsFiscalSettings): StsFiscalSettings {
    const profile = source.stsIssuerType === undefined ? current.stsIssuerType : source.stsIssuerType;
    if (profile !== null && !isStsIssuerType(profile)) fail('Seleziona un profilo valido per il Sistema Tessera Sanitaria.');
    if (source.stsDefaultExpenseTypeCode !== undefined && source.stsDefaultExpenseTypeCode !== null
        && typeof source.stsDefaultExpenseTypeCode !== 'string') fail('Seleziona un tipo di spesa sanitaria valido.');
    const changedProfile = profile !== current.stsIssuerType;
    const requested = source.stsDefaultExpenseTypeCode === undefined
        ? changedProfile ? null : current.stsDefaultExpenseTypeCode : clean(source.stsDefaultExpenseTypeCode);
    if (requested && (!profile || !isStsExpenseCode(profile, requested)))
        fail('Il tipo di spesa sanitaria non è previsto per il profilo dell’emittente selezionato.');
    return { stsIssuerType: profile, stsDefaultExpenseTypeCode: profile === 'PHYSIOTHERAPIST' ? 'SP' : requested };
}

export interface StsExpenseResolution {
    stsIssuerType: StsIssuerType | null;
    stsExpenseTypeCode: string | null;
    stsExpenseTypeSource: 'SAVED' | 'PROFILE' | null;
    issue: { field: 'stsIssuerType' | 'stsExpenseTypeCode'; message: string } | null;
}

/** Solo prestazioni, senza prodotti, possono ereditare il valore dichiarato nelle impostazioni. */
export function resolveStsExpenseType(invoice: Data, settings: StsFiscalSettings): StsExpenseResolution {
    const frozen = invoice.issuer?.stsIssuerType;
    const profile = frozen == null ? settings.stsIssuerType : isStsIssuerType(frozen) ? frozen : null;
    const result: StsExpenseResolution = { stsIssuerType: profile, stsExpenseTypeCode: null, stsExpenseTypeSource: null, issue: null };
    const saved = clean(invoice.stsExpenseTypeCode);
    if (!profile) {
        result.issue = { field: 'stsIssuerType', message: 'Configura il profilo dell’emittente in Impostazioni → Amministrazione → Collegamenti fiscali.' };
        return result;
    }
    if (saved) {
        if (!isStsExpenseCode(profile, saved)) result.issue = { field: 'stsExpenseTypeCode', message: 'Il tipo di spesa salvato non è previsto per il profilo dell’emittente. Correggilo nei dati Sistema Tessera Sanitaria della fattura.' };
        else { result.stsExpenseTypeCode = saved; result.stsExpenseTypeSource = 'SAVED'; }
        return result;
    }
    const onlyServices = Array.isArray(invoice.services) && invoice.services.length > 0
        && Array.isArray(invoice.products) && invoice.products.length === 0;
    const defaultCode = profile === 'PHYSIOTHERAPIST' ? 'SP'
        : profile === settings.stsIssuerType ? settings.stsDefaultExpenseTypeCode : null;
    if (onlyServices && defaultCode && isStsExpenseCode(profile, defaultCode)) {
        result.stsExpenseTypeCode = defaultCode; result.stsExpenseTypeSource = 'PROFILE';
    } else result.issue = { field: 'stsExpenseTypeCode', message: 'Seleziona il tipo di spesa nei dati Sistema Tessera Sanitaria della fattura.' };
    return result;
}

/** La configurazione TS non blocca l’emissione ordinaria; un codice esplicito deve essere valido. */
export function invoiceStsCodeForSave(invoice: Data, settings: StsFiscalSettings, explicitValue: unknown): string | null {
    if (explicitValue !== undefined && explicitValue !== null && typeof explicitValue !== 'string')
        fail('Seleziona un tipo di spesa sanitaria valido.');
    // An explicit blank is the user's "da definire" choice; only omission allows a saved default.
    if (explicitValue === null || (typeof explicitValue === 'string' && !explicitValue.trim())) return null;
    const resolution = resolveStsExpenseType(invoice, settings);
    if (clean(explicitValue) && resolution.issue) fail(resolution.issue.message);
    return resolution.stsExpenseTypeCode;
}

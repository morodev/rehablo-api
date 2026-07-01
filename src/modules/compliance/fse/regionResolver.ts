/**
 * Risoluzione "struttura → Regione" per l'instradamento del FSE.
 *
 * In un SaaS multi-tenant dove ogni tenant può avere più `Structure` (sedi), anche in Regioni
 * diverse fra loro, NON si può assumere una singola Regione/adapter per tenant: ogni documento
 * clinico deve essere instradato in base alla Regione della `Structure` in cui è stato
 * effettivamente erogato (`Evaluation.structureId`, con fallback su `Patient.structureId`).
 *
 * `Structure` vive nello schema "public" (condiviso, non tenant-scoped), quindi la query qui
 * non richiede `.schema(tenantSchema)` — stesso pattern già usato per `Tenant`/`User`.
 */
import Structure from '../../auth/models/structure.model.js';
import Patient from '../../patients/models/patient.model.js';

/**
 * Risolve la Regione (`Structure.region`) da usare per instradare un documento FSE, dato
 * l'eventuale `structureId` dell'atto clinico (es. `Evaluation.structureId`) e, in mancanza,
 * l'id del paziente da cui recuperare la struttura di riferimento anagrafico.
 *
 * Restituisce `null` se non è possibile determinare una struttura/regione: in tal caso il
 * chiamante deve trattare l'invio come NON instradabile (vedi `getFseAdapter(null)` che
 * ricade su `NullFseAdapter`), piuttosto che assumere una regione di default arbitraria.
 */
export async function resolveRegionForEvaluation(params: {
    tenantSchema: string;
    structureId?: string | null;
    patientId?: string | null;
}): Promise<string | null> {
    const { tenantSchema, structureId, patientId } = params;

    let effectiveStructureId = structureId ?? null;

    if (!effectiveStructureId && patientId) {
        const patient = await Patient.schema(tenantSchema).findByPk(patientId);
        effectiveStructureId = (patient?.get('structureId') as string | undefined) ?? null;
    }

    if (!effectiveStructureId) {
        return null;
    }

    const structure = await Structure.findByPk(effectiveStructureId);
    return (structure?.get('region') as string | undefined) ?? null;
}


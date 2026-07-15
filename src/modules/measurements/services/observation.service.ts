import MetricDefinition from '../models/catalog/metricDefinition.model.js';
import Observation from '../models/observation.model.js';
import type {
    ObservationAggregation,
    ObservationProvenance,
    ObservationSide
} from '../models/observation.model.js';
import type { MetricInfo } from '../mapping/types.js';

/**
 * Ciò che un canale (manuale, import, API, connettore) passa all'imbuto. È volutamente "canonico":
 * il canale ha già fatto l'eventuale traduzione/conversione a monte.
 */
export interface ObservationInput {
    patientId: string;
    metricCode: string;
    value: number;
    unit?: string;
    side?: ObservationSide;
    effectiveDateTime?: string | Date;
    sourceId?: string | null;
    trialNumber?: number | null;
    aggregation?: ObservationAggregation;
    calculationMethod?: string | null;
    provenance: ObservationProvenance;
    metadata?: Record<string, unknown> | null;
    evaluationId?: string | null;
    sessionId?: string | null;
}

export interface IngestContext {
    tenantId: string;
    operatorId?: string | null;
}

export interface IngestResult {
    created: Observation[];
    skipped: { input: ObservationInput; reason: string }[];
}

/** Carica dal dizionario (schema public) le info minime (unità canonica + verso) per i codici richiesti. */
export async function loadMetricInfo(codes?: string[]): Promise<Record<string, MetricInfo>> {
    const where = codes && codes.length ? { code: codes } : undefined;
    const defs = await MetricDefinition.findAll({ where: where as any });
    const map: Record<string, MetricInfo> = {};
    for (const d of defs) {
        map[d.get('code') as string] = {
            unit: d.get('unit') as string,
            higherIsBetter: d.get('higherIsBetter') as boolean
        };
    }
    return map;
}

/**
 * IMBUTO UNICO DI INGESTIONE.
 * Tutti i canali (manuale/CSV/API/connettori) finiscono qui: valida ogni misura contro il dizionario
 * (metrica esistente + unità coerente) e la salva come `Observation` canonica nello schema del tenant.
 */
export async function ingestObservations(
    schema: string,
    inputs: ObservationInput[],
    ctx: IngestContext
): Promise<IngestResult> {
    const codes = Array.from(new Set(inputs.map((i) => i.metricCode)));
    const dictionary = await loadMetricInfo(codes);

    const toCreate: any[] = [];
    const skipped: { input: ObservationInput; reason: string }[] = [];

    for (const input of inputs) {
        const def = dictionary[input.metricCode];
        if (!def) {
            skipped.push({ input, reason: `Metrica "${input.metricCode}" non presente nel dizionario` });
            continue;
        }
        const numericValue = Number(input.value);
        if (!Number.isFinite(numericValue)) {
            skipped.push({ input, reason: 'Valore numerico mancante o non valido' });
            continue;
        }
        const unit = input.unit ?? def.unit;
        if (unit !== def.unit) {
            skipped.push({
                input,
                reason: `Unità "${unit}" incoerente con l'unità canonica "${def.unit}" della metrica ${input.metricCode}`
            });
            continue;
        }

        toCreate.push({
            tenantId: ctx.tenantId,
            patientId: input.patientId,
            evaluationId: input.evaluationId ?? null,
            sessionId: input.sessionId ?? null,
            metricCode: input.metricCode,
            value: numericValue,
            unit,
            side: input.side ?? 'BILATERAL',
            trialNumber: input.trialNumber ?? null,
            aggregation: input.aggregation ?? 'SINGLE',
            effectiveDateTime: input.effectiveDateTime ? new Date(input.effectiveDateTime) : new Date(),
            sourceId: input.sourceId ?? null,
            operatorId: ctx.operatorId ?? null,
            quality: 'GOOD',
            calculationMethod: input.calculationMethod ?? null,
            provenance: input.provenance,
            metadata: input.metadata ?? null
        });
    }

    const created = toCreate.length
        ? await Observation.schema(schema).bulkCreate(toCreate, { returning: true })
        : [];

    return { created, skipped };
}

export interface ListObservationsFilter {
    patientId?: string;
    metricCode?: string;
}

/** Lettura delle Observation di un paziente (o filtrate per metrica). */
export async function listObservations(schema: string, filter: ListObservationsFilter): Promise<Observation[]> {
    const where: Record<string, unknown> = {};
    if (filter.patientId) where.patientId = filter.patientId;
    if (filter.metricCode) where.metricCode = filter.metricCode;

    return Observation.schema(schema).findAll({
        where,
        order: [
            ['effectiveDateTime', 'DESC'],
            ['metricCode', 'ASC']
        ]
    });
}



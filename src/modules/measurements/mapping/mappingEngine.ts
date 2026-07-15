import type {
    DeviceMapping,
    FieldFilter,
    MappedMeasurement,
    MappingRule,
    MetricInfo
} from './types.js';
import type { ObservationSide } from '../models/observation.model.js';

/** Tabella di conversione unità -> unità canonica. Estendibile. */
const UNIT_CONVERSIONS: Record<string, Record<string, number>> = {
    'ft-lb': { Nm: 1.3558179483 }, // piedi-libbra -> Newton-metro
    lbf: { N: 4.4482216153 }, // libbra-forza -> Newton
    kg: { N: 9.80665 }, // chilogrammo-forza -> Newton
    kgf: { N: 9.80665 }
};

function convertUnit(value: number, from: string, to: string): number {
    if (from === to) return value;
    const table = UNIT_CONVERSIONS[from];
    if (table && table[to] != null) return value * table[to];
    throw new Error(`Nessuna conversione definita da "${from}" a "${to}"`);
}

/** Parser CSV minimale (sufficiente per i file tabellari dei dinamometri). */
export function parseCsv(text: string): Record<string, string>[] {
    const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    if (lines.length === 0) return [];
    const headers = lines[0].split(',').map((h) => h.trim());
    return lines.slice(1).map((line) => {
        const cells = line.split(',').map((c) => c.trim());
        const row: Record<string, string> = {};
        headers.forEach((h, i) => (row[h] = cells[i] ?? ''));
        return row;
    });
}

/**
 * Ispeziona un CSV senza mapparlo: restituisce le colonne e qualche riga di esempio.
 * È ciò che il "mapping wizard" mostra all'operatore per far trascinare colonna -> metrica.
 */
export function inspectCsv(text: string, sampleSize = 5): { columns: string[]; sampleRows: Record<string, string>[] } {
    const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    if (lines.length === 0) return { columns: [], sampleRows: [] };
    const columns = lines[0].split(',').map((h) => h.trim());
    const rows = parseCsv(text);
    return { columns, sampleRows: rows.slice(0, sampleSize) };
}

function rowMatchesFilters(row: Record<string, string>, filters?: FieldFilter[]): boolean {
    if (!filters || filters.length === 0) return true;
    return filters.every((f) => {
        const cell = (row[f.column] ?? '').trim();
        const expected = Array.isArray(f.equals) ? f.equals : [f.equals];
        return expected.some((e) => e.trim() === cell);
    });
}

function resolveSide(row: Record<string, string>, rule: MappingRule, mapping: DeviceMapping): ObservationSide {
    if (rule.side && 'const' in rule.side) return rule.side.const;
    if (rule.side && 'column' in rule.side) {
        const raw = (row[rule.side.column] ?? '').trim();
        const mapped = mapping.sideAliases?.[raw];
        if (mapped) return mapped;
        const up = raw.toUpperCase();
        if (up === 'LEFT' || up === 'RIGHT' || up === 'BILATERAL') return up as ObservationSide;
    }
    return 'BILATERAL';
}

interface BaseHit {
    patientRef: string;
    effectiveDateTime: string;
    metricCode: string;
    side: ObservationSide;
    values: number[];
    unit: string;
    aggregation: 'BEST' | 'MEAN' | 'RAW';
}

function round(n: number, decimals: number): number {
    const f = Math.pow(10, decimals);
    return Math.round(n * f) / f;
}

/**
 * Applica la mappatura di UN dispositivo al contenuto di un CSV e restituisce le misure canoniche
 * (già nell'unità del dizionario), con aggregazione della prova migliore + metriche derivate (LSI).
 *
 * `dictionary` fornisce, per ogni metricCode, l'unità canonica e `higherIsBetter` (dal DB).
 */
export function applyMapping(
    csvText: string,
    mapping: DeviceMapping,
    dictionary: Record<string, MetricInfo>
): { measurements: MappedMeasurement[]; warnings: string[] } {
    const rows = parseCsv(csvText);
    const hits = new Map<string, BaseHit>();
    const warnings: string[] = [];

    for (const row of rows) {
        const patientRef = mapping.patientColumn ? (row[mapping.patientColumn] ?? '').trim() : '';
        const date = (row[mapping.dateColumn] ?? '').trim();

        for (const rule of mapping.rules) {
            if (!rowMatchesFilters(row, rule.filters)) continue;

            const def = dictionary[rule.metricCode];
            if (!def) {
                warnings.push(`Metrica sconosciuta nel dizionario: ${rule.metricCode} (riga ignorata)`);
                continue;
            }

            const raw = (row[rule.valueColumn] ?? '').trim();
            if (raw === '') continue;
            const parsed = Number(raw.replace(',', '.'));
            if (Number.isNaN(parsed)) continue;

            const converted = convertUnit(parsed, rule.fromUnit, def.unit) * (rule.factor ?? 1);
            const side = resolveSide(row, rule, mapping);
            const aggregation = rule.aggregation ?? 'BEST';
            const key = `${patientRef}|${date}|${rule.metricCode}|${side}`;

            const existing = hits.get(key);
            if (existing) {
                existing.values.push(converted);
            } else {
                hits.set(key, {
                    patientRef,
                    effectiveDateTime: date,
                    metricCode: rule.metricCode,
                    side,
                    values: [converted],
                    unit: def.unit,
                    aggregation
                });
            }
        }
    }

    const measurements: MappedMeasurement[] = [];
    for (const hit of Array.from(hits.values())) {
        const def = dictionary[hit.metricCode];
        let value: number;
        if (hit.aggregation === 'MEAN') {
            value = hit.values.reduce((a, b) => a + b, 0) / hit.values.length;
        } else if (hit.aggregation === 'BEST') {
            value = def.higherIsBetter ? Math.max(...hit.values) : Math.min(...hit.values);
        } else {
            value = hit.values[hit.values.length - 1];
        }
        measurements.push({
            metricCode: hit.metricCode,
            value: round(value, 2),
            unit: hit.unit,
            side: hit.side,
            effectiveDateTime: hit.effectiveDateTime,
            sourceId: mapping.sourceId,
            provenance: 'IMPORT',
            aggregation: hit.aggregation
        });
    }

    // Metriche derivate (LSI = più debole / più forte * 100)
    for (const der of mapping.derivations ?? []) {
        const byDate = new Map<string, { left?: number; right?: number; date: string }>();
        for (const m of measurements) {
            if (m.metricCode !== der.fromMetric) continue;
            const entry = byDate.get(m.effectiveDateTime) ?? { date: m.effectiveDateTime };
            if (m.side === 'LEFT') entry.left = m.value;
            if (m.side === 'RIGHT') entry.right = m.value;
            byDate.set(m.effectiveDateTime, entry);
        }
        for (const entry of Array.from(byDate.values())) {
            if (entry.left == null || entry.right == null) continue;
            const weaker = Math.min(entry.left, entry.right);
            const stronger = Math.max(entry.left, entry.right);
            if (stronger === 0) continue;
            measurements.push({
                metricCode: der.metricCode,
                value: round((weaker / stronger) * 100, 1),
                unit: '%',
                side: 'BILATERAL',
                effectiveDateTime: entry.date,
                sourceId: mapping.sourceId,
                provenance: 'DERIVED',
                aggregation: 'SINGLE',
                calculationMethod: 'weaker/stronger×100'
            });
        }
    }

    return { measurements, warnings };
}


import type {
    DeviceMapping,
    FieldFilter,
    MappingRule,
    MetricDefinition,
    Observation,
    Side
} from './types.js';

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

function rowMatchesFilters(row: Record<string, string>, filters?: FieldFilter[]): boolean {
    if (!filters || filters.length === 0) return true;
    return filters.every((f) => {
        const cell = (row[f.column] ?? '').trim();
        const expected = Array.isArray(f.equals) ? f.equals : [f.equals];
        return expected.some((e) => e.trim() === cell);
    });
}

function resolveSide(row: Record<string, string>, rule: MappingRule, mapping: DeviceMapping): Side {
    if (rule.side && 'const' in rule.side) return rule.side.const;
    if (rule.side && 'column' in rule.side) {
        const raw = (row[rule.side.column] ?? '').trim();
        const mapped = mapping.sideAliases?.[raw];
        if (mapped) return mapped;
        const up = raw.toUpperCase();
        if (up === 'LEFT' || up === 'RIGHT' || up === 'BILATERAL') return up as Side;
    }
    return 'BILATERAL';
}

interface BaseHit {
    key: string; // patient|date|metric|side
    patientRef: string;
    effectiveDateTime: string;
    metricCode: string;
    side: Side;
    values: number[];
    unit: string;
    aggregation: 'BEST' | 'MEAN' | 'RAW';
}

/**
 * Applica la mappatura di UN dispositivo al contenuto di un CSV e restituisce le Observation
 * canoniche (già nell'unità del dizionario), con aggregazione della prova migliore + LSI derivato.
 */
export function applyMapping(
    csvText: string,
    mapping: DeviceMapping,
    dictionary: Record<string, MetricDefinition>
): Observation[] {
    const rows = parseCsv(csvText);
    const hits = new Map<string, BaseHit>();

    // 1) Righe base: applica ogni regola a ogni riga che supera i filtri
    for (const row of rows) {
        const patientRef = (row[mapping.patientColumn] ?? '').trim();
        const date = (row[mapping.dateColumn] ?? '').trim();

        for (const rule of mapping.rules) {
            if (!rowMatchesFilters(row, rule.filters)) continue;

            const def = dictionary[rule.metricCode];
            if (!def) {
                console.warn(`[mapping] metrica sconosciuta nel dizionario: ${rule.metricCode}`);
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
                    key,
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

    // 2) Aggregazione (prova migliore / media)
    const observations: Observation[] = [];
    for (const hit of Array.from(hits.values())) {
        const def = dictionary[hit.metricCode];
        let value: number;
        if (hit.aggregation === 'MEAN') {
            value = hit.values.reduce((a, b) => a + b, 0) / hit.values.length;
        } else {
            // BEST: max se "higherIsBetter", altrimenti min
            value = def.higherIsBetter ? Math.max(...hit.values) : Math.min(...hit.values);
        }
        observations.push({
            patientRef: hit.patientRef,
            metricCode: hit.metricCode,
            value: round(value, 2),
            unit: hit.unit,
            side: hit.side,
            effectiveDateTime: hit.effectiveDateTime,
            sourceId: mapping.sourceId,
            provenance: 'IMPORT'
        });
    }

    // 3) Metriche derivate (LSI = più debole / più forte * 100)
    for (const der of mapping.derivations ?? []) {
        const byPatientDate = new Map<string, { left?: number; right?: number; date: string; patient: string }>();
        for (const obs of observations) {
            if (obs.metricCode !== der.fromMetric) continue;
            const k = `${obs.patientRef}|${obs.effectiveDateTime}`;
            const entry = byPatientDate.get(k) ?? { date: obs.effectiveDateTime, patient: obs.patientRef };
            if (obs.side === 'LEFT') entry.left = obs.value;
            if (obs.side === 'RIGHT') entry.right = obs.value;
            byPatientDate.set(k, entry);
        }
        for (const entry of Array.from(byPatientDate.values())) {
            if (entry.left == null || entry.right == null) continue;
            const weaker = Math.min(entry.left, entry.right);
            const stronger = Math.max(entry.left, entry.right);
            if (stronger === 0) continue;
            observations.push({
                patientRef: entry.patient,
                metricCode: der.metricCode,
                value: round((weaker / stronger) * 100, 1),
                unit: '%',
                side: 'BILATERAL',
                effectiveDateTime: entry.date,
                sourceId: mapping.sourceId,
                provenance: 'DERIVED',
                calculationMethod: 'weaker/stronger×100'
            });
        }
    }

    return observations;
}

function round(n: number, decimals: number): number {
    const f = Math.pow(10, decimals);
    return Math.round(n * f) / f;
}




import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { METRIC_DICTIONARY } from './metricDictionary.js';
import { applyMapping } from './mappingEngine.js';
import { kinventKForceMapping } from './mappings/kinvent.mapping.js';
import { biodexIsoMapping } from './mappings/biodex.mapping.js';
import type { DeviceMapping, Observation } from './types.js';

// Eseguire dalla root del backend: `node_modules\.bin\tsx examples\device-mappings\run.ts`
const here = join(process.cwd(), 'examples', 'device-mappings');

/**
 * Simula ciò che farebbe l'endpoint `POST /v1/imports`:
 * riceve un file + il `sourceId` scelto dall'operatore, sceglie la mappatura corrispondente e
 * produce le Observation canoniche.
 */
const REGISTRY: Record<string, { mapping: DeviceMapping; sampleFile: string }> = {
    'kinvent-kforce': { mapping: kinventKForceMapping, sampleFile: 'kinvent-sample.csv' },
    'biodex-iso': { mapping: biodexIsoMapping, sampleFile: 'biodex-sample.csv' }
};

function importFromDevice(sourceId: string): Observation[] {
    const entry = REGISTRY[sourceId];
    if (!entry) throw new Error(`sourceId sconosciuto: ${sourceId}`);
    const csv = readFileSync(join(here, 'samples', entry.sampleFile), 'utf8');
    return applyMapping(csv, entry.mapping, METRIC_DICTIONARY);
}

function printObservations(title: string, obs: Observation[]): void {
    console.log('\n' + '='.repeat(78));
    console.log(title);
    console.log('='.repeat(78));
    console.log(
        pad('metricCode', 26) +
            pad('side', 11) +
            pad('value', 10) +
            pad('unit', 6) +
            pad('provenance', 11) +
            'note'
    );
    console.log('-'.repeat(78));
    for (const o of obs) {
        console.log(
            pad(o.metricCode, 26) +
                pad(o.side, 11) +
                pad(String(o.value), 10) +
                pad(o.unit, 6) +
                pad(o.provenance, 11) +
                (o.calculationMethod ?? '')
        );
    }
}

function pad(s: string, n: number): string {
    return (s + ' '.repeat(n)).slice(0, n);
}

// --- DEMO ---
console.log('\nRehablo — demo motore di mappatura dispositivi (dinamometri)\n');
console.log('L\'operatore ha caricato un file e ha selezionato il dispositivo (sourceId).');
console.log('Il backend sceglie la mappatura giusta e produce le stesse Observation canoniche.');

const kinvent = importFromDevice('kinvent-kforce');
printObservations('DISPOSITIVO A — Kinvent K-Force  (file in NEWTON, lato "Left/Right")', kinvent);

const biodex = importFromDevice('biodex-iso');
printObservations('DISPOSITIVO B — Biodex isocinetico  (file in FT-LB, lato "L/R", colonne diverse)', biodex);

console.log('\n' + '='.repeat(78));
console.log('CONCLUSIONE');
console.log('='.repeat(78));
console.log('• Due file con colonne e unità DIVERSE (N vs ft-lb, "Left" vs "L").');
console.log('• Due mappature DIVERSE (una per sourceId).');
console.log('• Output OMOGENEO in `observations`: stesse strutture, unità canoniche, LSI calcolato.');
console.log('• Il core / l\'AI / il RehabloScore leggono solo le Observation, non conoscono il device.\n');



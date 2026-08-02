/**
 * Backfill di `structureId` — esecuzione manuale.
 *
 *   npm run backfill:structure            # DRY RUN: non scrive nulla
 *   npm run backfill:structure -- --apply
 *
 * NOTA: in condizioni normali NON serve lanciarlo a mano. Lo stesso backfill viene eseguito
 * automaticamente a ogni avvio del server (vedi `server.ts`), perché è idempotente e tocca
 * solo le righe con `structureId IS NULL`.
 *
 * Questo script resta utile per:
 * - vedere in DRY RUN cosa verrebbe assegnato, prima di un deploy;
 * - verificare quanti record restano ambigui e vanno sistemati a mano.
 *
 * Dettagli sulla strategia di assegnazione: `structureBackfill.service.ts`.
 */

import { connectDatabase, sequelize } from '../config/database.js';
import { runStructureBackfill } from '../modules/auth/services/structureBackfill.service.js';

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
    await connectDatabase();

    console.log(
        APPLY
            ? '=== BACKFILL structureId — APPLY (scrive sul database) ==='
            : '=== BACKFILL structureId — DRY RUN ===\n    Aggiungi --apply per eseguire davvero.'
    );

    const report = await runStructureBackfill({ apply: APPLY, verbose: true });

    console.log(`\nTenant analizzati: ${report.tenants}`);

    const updated = Object.entries(report.updated);
    if (updated.length === 0) {
        console.log('Nessun record da aggiornare: il backfill è già completo.');
    } else {
        console.log(APPLY ? 'Record aggiornati:' : 'Record che verrebbero aggiornati:');
        for (const [table, count] of updated) {
            console.log(`  ${table}: ${count}`);
        }
    }

    const ambiguous = Object.entries(report.ambiguous);
    if (ambiguous.length > 0) {
        console.log('\n⚠ Record che restano senza sede (assegnazione ambigua, da decidere a mano):');
        for (const [table, count] of ambiguous) {
            console.log(`  ${table}: ${count}`);
        }
    } else {
        console.log('\nNessun record ambiguo: si può rimuovere `includeUnassigned` dai controller.');
    }

    await sequelize.close();
}

main().catch(async (err) => {
    console.error('[backfill] errore:', err);
    await sequelize.close();
    process.exit(1);
});

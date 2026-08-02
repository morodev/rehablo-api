/**
 * Audit RBAC: verifica che ogni rotta che tocca dati dichiari un controllo di permessi.
 *
 *   npm run audit:rbac
 *
 * Esce con codice 1 se trova rotte non protette che non siano nella allow-list qui sotto,
 * così può essere usato in CI come rete di sicurezza sul principio deny-by-default.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const MODULES_DIR = join(ROOT, 'src', 'modules');

/**
 * Rotte volutamente prive di `requirePermission`.
 * Motivo per ciascuna: vedi docs/RBAC_DESIGN.md §9.
 */
const ALLOWED_WITHOUT_PERMISSION = [
    // Flussi di autenticazione
    "'/auth/login'",
    "'/auth/refresh'",
    "'/auth/login-premise/:premiseId'",
    "'/auth/logout'",
    "'/auth/login-token'",
    "'/auth/me'",
    "'/auth/me/permissions'",
    // Registrazione tenant e flussi pubblici basati su token in URL
    "'/tenant'",
    "'/user/verify/:verificationToken'",
    "'/send-verification'",
    "'/user/forgot-password'",
    "'/user/reset-password/:resetPasswordToken'",
    // Self-service: il controller verifica che l'utente stia modificando se stesso
    "'/user/:userId/calendar-visibility'",
    "'/user/:userId/calendar-color'"
];

const GUARD_PATTERN = /requirePermission|requireAnyPermission|requireSuperAdmin/;
const ROUTE_PATTERN = /^\s*router\.(get|post|put|patch|delete)\(/;

function collectRouteFiles(dir) {
    const files = [];
    for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry);
        if (statSync(fullPath).isDirectory()) {
            files.push(...collectRouteFiles(fullPath));
        } else if (entry.endsWith('.routes.ts')) {
            files.push(fullPath);
        }
    }
    return files;
}

const unprotected = [];
let total = 0;

for (const file of collectRouteFiles(MODULES_DIR)) {
    const lines = readFileSync(file, 'utf8').split('\n');

    lines.forEach((line, index) => {
        if (!ROUTE_PATTERN.test(line)) return;
        total += 1;

        if (GUARD_PATTERN.test(line)) return;
        if (ALLOWED_WITHOUT_PERMISSION.some((allowed) => line.includes(allowed))) return;

        unprotected.push({
            file: relative(ROOT, file),
            line: index + 1,
            code: line.trim()
        });
    });
}

console.log(`[audit:rbac] rotte analizzate: ${total}`);

if (unprotected.length === 0) {
    console.log('[audit:rbac] OK - ogni rotta dichiara un controllo di permessi');
    process.exit(0);
}

console.error(`[audit:rbac] ${unprotected.length} rotte SENZA controllo di permessi:\n`);
for (const item of unprotected) {
    console.error(`  ${item.file}:${item.line}`);
    console.error(`    ${item.code}\n`);
}
console.error('Aggiungi requirePermission(...) oppure inserisci la rotta nella allow-list di scripts/audit-rbac.mjs');
process.exit(1);


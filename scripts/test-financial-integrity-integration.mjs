import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {requireFinancialTestDatabase} from './financial-test-database.mjs';

// Validate before importing application configuration. No .env or DATABASE_URL fallback.
try { requireFinancialTestDatabase(process.env); }
catch (error) { console.error(error.message); process.exitCode = 1; }
if (!process.exitCode) {
    const require = createRequire(import.meta.url);
    const child = spawn(process.execPath, [require.resolve('tsx/cli'), '--test', '--test-concurrency=1',
        'scripts/financial-test-database.test.mjs',
        'src/modules/agenda/controllers/appointmentPricing.integration.test.ts',
        'src/modules/administration/tests/financialIntegrity.integration.test.ts'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit',
        env: {...process.env, NODE_ENV: 'test', DB_SSL: 'false'}
    });
    child.on('error', () => { console.error('Could not start the financial integration test runner.'); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}

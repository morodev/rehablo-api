import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';
import {requireActivitiesTestDatabase} from './activities-test-database.mjs';

// Reuse the existing disposable-database guard; DATABASE_URL is never a fallback.
dotenv.config();
try {
    requireActivitiesTestDatabase(process.env);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
if (!process.exitCode) {
    const require = createRequire(import.meta.url);
    const tests = [
        'src/modules/auth/tests/authSecurity.integration.test.ts',
        'src/middleware/rbacFiltering.integration.test.ts',
        'src/modules/evaluations/tests/clinicalTransactions.integration.test.ts'
    ];
    const child = spawn(process.execPath, [require.resolve('tsx/cli'), '--test', '--test-concurrency=1', ...tests], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        stdio: 'inherit',
        env: {...process.env, NODE_ENV: 'test'}
    });
    child.on('error', error => {
        console.error(`Could not start the critical fixes integration test runner: ${error.message}`);
        process.exitCode = 1;
    });
    child.on('exit', (code, signal) => {
        process.exitCode = code ?? (signal ? 1 : 0);
    });
}

import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readdirSync} from 'node:fs';
import dotenv from 'dotenv';
import {requireActivitiesTestDatabase} from './activities-test-database.mjs';

// Loading configuration is read-only. Never print its values or substitute the ordinary URL.
dotenv.config();
try {
    requireActivitiesTestDatabase(process.env);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
if (!process.exitCode) {
    const require = createRequire(import.meta.url);
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const testDirectory = 'src/modules/activities/tests';
    const tests = readdirSync(new URL('../src/modules/activities/tests/', import.meta.url))
        .filter(name => name.endsWith('.integration.test.ts')).sort().map(name => `${testDirectory}/${name}`);
    if (!tests.length) throw new Error('No Activities integration tests were found.');
    const child = spawn(process.execPath, [require.resolve('tsx/cli'), '--test', '--test-concurrency=1',
        ...tests], {
        cwd, stdio: 'inherit', env: {...process.env, NODE_ENV: 'test'}
    });
    child.on('error', error => {
        console.error(`Could not start the activities integration test runner: ${error.message}`);
        process.exitCode = 1;
    });
    child.on('exit', (code, signal) => {
        process.exitCode = code ?? (signal ? 1 : 0);
    });
}

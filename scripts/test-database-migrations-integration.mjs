import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

/** Validate before importing application configuration; never substitute DATABASE_URL. */
export function requireMigrationsTestDatabase(environment = process.env) {
    const value = environment.TEST_MIGRATIONS_DATABASE_URL;
    if (!value?.trim()) {
        throw new Error('TEST_MIGRATIONS_DATABASE_URL is required; migration integration tests never fall back to DATABASE_URL.');
    }
    let target;
    try { target = new URL(value); }
    catch { throw new Error('TEST_MIGRATIONS_DATABASE_URL must be a PostgreSQL URL.'); }
    const isLoopback = hostname => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname.toLowerCase());
    if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.hash || !isLoopback(target.hostname)) {
        throw new Error('Migration integration tests require a dedicated PostgreSQL database on localhost.');
    }
    let databaseName;
    try { databaseName = decodeURIComponent(target.pathname.slice(1)); }
    catch { throw new Error('The migration integration database name is invalid.'); }
    if (databaseName.length > 63 || !/^[a-z][a-z0-9_]*_migrations_test(?:_[a-z0-9_]+)?$/.test(databaseName)) {
        throw new Error('Use a dedicated database named <prefix>_migrations_test or <prefix>_migrations_test_<run>.');
    }
    if (environment.DATABASE_URL) {
        let ordinary;
        try { ordinary = new URL(environment.DATABASE_URL); }
        catch { throw new Error('Cannot confirm isolation from the ordinary database.'); }
        const endpoint = url => `${isLoopback(url.hostname) ? 'loopback' : url.hostname.toLowerCase()}:${url.port || '5432'}/${decodeURIComponent(url.pathname.slice(1))}`;
        if (endpoint(ordinary) === endpoint(target)) {
            throw new Error('The migration integration database must differ from DATABASE_URL, regardless of credentials.');
        }
    }
    return {databaseUrl: value, databaseName};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    try { requireMigrationsTestDatabase(process.env); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    if (!process.exitCode) {
        const require = createRequire(import.meta.url);
        const child = spawn(process.execPath, [require.resolve('tsx/cli'), '--test', '--test-concurrency=1',
            'src/database/databaseMigrations.integration.test.ts',
            'src/database/schemaBaseline.integration.test.ts',
            'src/database/ledgerLocks.integration.test.ts',
            'src/database/deployment.integration.test.ts',
            'src/database/legacyDeployment.integration.test.ts',
            'src/database/startCommand.integration.test.ts'], {
            cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit',
            env: {...process.env, NODE_ENV: 'test', DB_SSL: 'false'}
        });
        child.on('error', () => { console.error('Could not start the migration integration test runner.'); process.exitCode = 1; });
        child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
    }
}

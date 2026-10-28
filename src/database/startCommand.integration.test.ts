import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {get} from 'node:http';
import {dirname, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {Sequelize} from 'sequelize';
import {requireMigrationsTestDatabase} from '../../scripts/test-database-migrations-integration.mjs';

test('disk-backed replacement retires the legacy writer before the actual npm start migrates and serves traffic',
    {timeout: 180000}, async t => {
    const target = requireMigrationsTestDatabase(process.env);
    Object.assign(process.env, {DATABASE_URL: target.databaseUrl, NODE_ENV: 'production', DB_SSL: 'false',
        JWT_SECRET: randomBytes(32).toString('hex'), DEVICE_CREDENTIALS_SECRET: randomBytes(32).toString('hex'),
        BACKGROUND_JOBS_ENABLED: 'false', ACTIVITIES_DELIVERY_ENABLED: 'false', REMINDER_EXTERNAL_DELIVERY_ENABLED: 'false'});
    const directory = fileURLToPath(new URL('../..', import.meta.url));
    // Invoke npm itself, so the checked-in start command and its && failure handling are exercised.
    const npmCli = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
        .find((candidate): candidate is string => !!candidate && /npm-cli\.js$/i.test(candidate) && existsSync(candidate));
    assert.ok(npmCli, 'Run through npm or install npm beside the Node executable');
    assert.ok(existsSync(join(directory, 'dist/server.js')), 'Build the deployment artifact before running this test');
    const scripts = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).scripts;
    assert.equal(scripts.start, 'npm run db:migrate && node dist/server.js');
    const {provisionTenantSchema, requiredMigrationNames} = await import('./standardMigrations.js');
    const {schemaBaseline} = await import('./schemaBaseline.js');
    const {sequelize: modelDatabase} = await import('../config/database.js');
    const database = new Sequelize(target.databaseUrl, {dialect: 'postgres', logging: false,
        dialectOptions: {ssl: false}, pool: {max: 2, min: 0}});
    const tenantId = randomUUID(), patientId = randomUUID(), structureId = randomUUID();
    const schema = 'rehablo_' + tenantId.replaceAll('-', '');
    const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    const prefix = quote(schema);
    const knownTables = new Set([...schemaBaseline.public.map(table => table.name),
        'SequelizeMeta', 'platform_schema_migrations', 'auth_schema_migrations', 'auth_security_migrations',
        'activity_notification_migrations', 'activity_notification_preferences', 'account_action_tokens']);
    const knownEnums = new Set(schemaBaseline.public.flatMap(table => table.enums.flatMap(sql =>
        [...sql.matchAll(/CREATE TYPE "public"\."([^"]+)"/g)].map(match => match[1]))));
    type Running = {child: ChildProcess; output(): string; done: Promise<number | null>};
    const children = new Set<Running>();
    let ownsFixture = false;

    const launch = (args: string[]): Running => {
        const child = spawn(process.execPath, args, {cwd: directory,
            env: {...process.env, PORT: '0'}, windowsHide: true, detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe']});
        let output = '';
        child.stdout!.on('data', chunk => {output += String(chunk);});
        child.stderr!.on('data', chunk => {output += String(chunk);});
        const done = new Promise<number | null>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', code => resolve(code));
        });
        // A spawn failure is also surfaced by waitFor/finished; avoid an unhandled early rejection.
        void done.catch(() => {});
        const running = {child, output: () => output, done};
        children.add(running);
        return running;
    };
    const stop = async (running: Running) => {
        const {child} = running;
        if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
            // npm owns a shell and Node descendants: retire exactly this test's process tree.
            if (process.platform === 'win32') {
                const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'],
                    {windowsHide: true, stdio: 'ignore'});
                await new Promise<void>((resolve, reject) => {
                    killer.once('error', reject);
                    killer.once('close', code => code === 0 || child.exitCode !== null || child.signalCode !== null
                        ? resolve() : reject(new Error('Could not stop owned test process tree ' + child.pid)));
                });
            } else {
                try {process.kill(-child.pid, 'SIGKILL');}
                catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}
            }
        }
        await running.done;
        children.delete(running);
    };
    const finished = async (running: Running) => {
        const timer = setTimeout(() => {void stop(running);}, 45000);
        try {return {code: await running.done, output: running.output()};}
        finally {clearTimeout(timer); await stop(running);}
    };
    const waitFor = async (predicate: () => boolean | Promise<boolean>, message: string, running: Running) => {
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline && running.child.exitCode === null && running.child.signalCode === null) {
            if (await predicate()) return;
            await delay(50);
        }
        throw new Error(message + ': ' + running.output());
    };
    const health = (port: number): Promise<number> => new Promise((resolve, reject) => {
        const request = get('http://127.0.0.1:' + port + '/health', response => {
            response.resume(); resolve(response.statusCode ?? 0);
        });
        request.once('error', reject);
        request.setTimeout(1000, () => request.destroy(new Error('Health request timed out')));
    });
    const startHealthy = async () => {
        const running = launch([npmCli, 'start']);
        await waitFor(async () => {
            const port = running.output().match(/listening on 0\.0\.0\.0:(\d+)/)?.[1];
            if (!port) return false;
            try {return await health(Number(port)) === 200;} catch {return false;}
        }, 'Actual npm start did not become healthy', running);
        return running;
    };
    const metadata = async (current = 'public') => {
        const [rows] = await database.query('SELECT name FROM ' + quote(current) + '."SequelizeMeta" ORDER BY name');
        return (rows as Array<{name: string}>).map(row => row.name);
    };
    const snapshotPatient = async () => {
        const [rows] = await database.query('SELECT * FROM ' + prefix + '.patients WHERE id=:id',
            {replacements: {id: patientId}});
        return rows;
    };
    const snapshotHistory = async () => {
        const [rows] = await database.query('SELECT version,"appliedAt" FROM ' + prefix + '.schema_migrations ORDER BY version');
        return rows as Array<{version: string; appliedAt: Date}>;
    };

    try {
        await database.authenticate();
        const [identity] = await database.query('SELECT current_database() AS name');
        assert.equal((identity[0] as {name: string}).name, target.databaseName);
        const [existing] = await database.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
        const [existingEnums] = await database.query("SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e'");
        assert.equal(existing.length, 0, 'Start-command tests require an empty disposable database');
        assert.equal(existingEnums.length, 0, 'Start-command tests require no pre-existing public enums');
        ownsFixture = true;
        const initial = await finished(launch([npmCli, 'run', 'db:migrate']));
        assert.equal(initial.code, 0, initial.output);
        await database.query(`INSERT INTO public.tenants(id,license,"idStripe","maxUserQuantity","maxStructureQuantity","createdAt","updatedAt")
            VALUES (:id,'synthetic-start-test','synthetic',1,1,NOW(),NOW())`, {replacements: {id: tenantId}});
        await database.query(`INSERT INTO public.structures(id,"tenantId",name,"createdAt","updatedAt")
            VALUES (:id,:tenant,'Synthetic start structure',NOW(),NOW())`, {replacements: {id: structureId, tenant: tenantId}});
        await database.transaction(transaction => provisionTenantSchema(database, schema, transaction));
        // Reconstruct legacy bookkeeping and a genuinely pending change, not just an empty ideal schema.
        await database.query('DROP TABLE ' + prefix + '."SequelizeMeta"');
        await database.query('DELETE FROM public."SequelizeMeta"');
        await database.query('ALTER TABLE ' + prefix + '.schema_migrations DROP COLUMN checksum');
        await database.query('DELETE FROM ' + prefix + ".schema_migrations WHERE version LIKE '20261028-%'");
        await database.query('INSERT INTO ' + prefix + `.schema_migrations(version,"appliedAt")
            VALUES ('20261026-tenant-model-baseline-v21','2026-10-26T00:00:00Z')`);
        await database.query('DROP TABLE ' + prefix + '.appointment_reminder_deliveries');
        await database.query('INSERT INTO ' + prefix + `.patients
            (id,"tenantId","userId","structureId",name,surname,emails,"phoneNumbers","createdAt","updatedAt")
            VALUES (:id,:tenant,:user,:structure,'Synthetic patient','Preserved',
                ARRAY['{"email":"fixture@example.invalid"}'::jsonb],
                ARRAY['{"number":"0000000000","label":"mobile"}'::jsonb],NOW(),NOW())`,
            {replacements: {id: patientId, tenant: tenantId, user: randomUUID(), structure: structureId}});
        const beforePatient = await snapshotPatient(), beforeHistory = await snapshotHistory();
        const writer = launch(['--input-type=module', '-e', `
            import {createRequire} from 'node:module';
            const require = createRequire(${JSON.stringify(join(directory, 'package.json'))});
            const {Sequelize} = require('sequelize');
            const database = new Sequelize(process.env.DATABASE_URL, {dialect:'postgres', logging:false,
                dialectOptions:{ssl:false},pool:{max:1,min:0}});
            const transaction = await database.transaction();
            await database.query('SELECT pg_advisory_xact_lock(hashtext(:schema),hashtext(:operation))',
                {transaction,replacements:{schema:${JSON.stringify(schema)},operation:'tenant-schema-migrations'}});
            await database.query(${JSON.stringify('UPDATE ' + prefix + '.patients SET surname=\'Uncommitted old writer\' WHERE id=:id')},
                {transaction,replacements:{id:${JSON.stringify(patientId)}}});
            const [rows] = await database.query('SELECT pg_backend_pid() AS pid',{transaction});
            console.log('WRITER_READY:' + rows[0].pid);
            setInterval(() => {}, 1000);
        `]);
        await waitFor(() => /WRITER_READY:(\d+)/.test(writer.output()), 'Legacy writer did not acquire its transaction lock', writer);
        const writerPid = Number(writer.output().match(/WRITER_READY:(\d+)/)![1]);

        await t.test('the preceding pre-deploy fails with the reported advisory lock timeout', async () => {
            const result = await finished(launch([npmCli, 'run', 'db:migrate']));
            assert.equal(result.code, 1, result.output);
            assert.match(result.output, /55P03/);
            assert.match(result.output, /tenant migration advisory lock/);
            assert.deepEqual(await metadata(), []);
            const [rows] = await database.query('SELECT to_regclass(:table) AS table', {replacements: {table: prefix + '."SequelizeMeta"'}});
            assert.deepEqual(rows, [{table: null}], 'Failed tenant work cannot create a successful migration receipt');
        });
        await t.test('npm start propagates migration failure and never launches the API while the writer is still active', async () => {
            const result = await finished(launch([npmCli, 'start']));
            assert.equal(result.code, 1, result.output);
            assert.match(result.output, /55P03/);
            assert.doesNotMatch(result.output, /\[rehablo-api\] listening|bootstrap complete/);
            assert.deepEqual(await metadata(), []);
            assert.deepEqual(await snapshotHistory(), beforeHistory);
        });
        await t.test('retiring the previous process rolls back its write and releases the lock before replacement startup', async () => {
            await stop(writer);
            // OS process termination closes its PostgreSQL connection; verify the database has observed it.
            const deadline = Date.now() + 5000;
            let connected = true;
            while (connected && Date.now() < deadline) {
                const [rows] = await database.query('SELECT pid FROM pg_stat_activity WHERE pid=:pid', {replacements: {pid: writerPid}});
                connected = rows.length > 0;
                if (connected) await delay(25);
            }
            assert.equal(connected, false, 'The old writer connection must be closed before migration starts');
            assert.deepEqual(await snapshotPatient(), beforePatient, 'Termination rolls back the old uncommitted patient change');
            await database.transaction(async transaction => {
                const [rows] = await database.query('SELECT pg_try_advisory_xact_lock(hashtext(:schema),hashtext(:operation)) AS acquired',
                    {transaction, replacements: {schema, operation: 'tenant-schema-migrations'}});
                assert.deepEqual(rows, [{acquired: true}], 'The replacement can acquire the original, unchanged lock');
            });
            const server = await startHealthy();
            try {
                assert.match(server.output(), /202610280001-initial-schema: migrated/);
                assert.match(server.output(), /202610280002-appointment-reminders: migrated/);
                assert.deepEqual(await metadata(), requiredMigrationNames);
                assert.deepEqual(await metadata(schema), requiredMigrationNames);
                assert.deepEqual(await snapshotPatient(), beforePatient);
                const historicalNames = new Set(beforeHistory.map(row => row.version));
                assert.deepEqual((await snapshotHistory()).filter(row => historicalNames.has(row.version)), beforeHistory);
            } finally {await stop(server);}
        });
        await t.test('a subsequent actual npm start skips completed migrations and preserves data and history', async () => {
            const beforeRestart = await snapshotHistory();
            const server = await startHealthy();
            try {
                assert.match(server.output(), /No migrations were executed/);
                assert.deepEqual(await snapshotPatient(), beforePatient);
                assert.deepEqual(await snapshotHistory(), beforeRestart);
                assert.deepEqual(await metadata(), requiredMigrationNames);
                assert.deepEqual(await metadata(schema), requiredMigrationNames);
            } finally {await stop(server);}
        });
    } finally {
        try {
            for (const child of children) await stop(child);
            if (ownsFixture) {
                await database.query('DROP SCHEMA IF EXISTS ' + prefix + ' CASCADE');
                const [tables] = await database.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
                for (const row of tables as Array<{tablename: string}>) {
                    assert.ok(knownTables.has(row.tablename), 'Refusing cleanup of an unowned table: ' + row.tablename);
                    await database.query('DROP TABLE public.' + quote(row.tablename) + ' CASCADE');
                }
                const [types] = await database.query("SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e'");
                for (const row of types as Array<{typname: string}>) {
                    assert.ok(knownEnums.has(row.typname), 'Refusing cleanup of an unowned enum: ' + row.typname);
                    await database.query('DROP TYPE public.' + quote(row.typname));
                }
            }
        } finally {await database.close(); await modelDatabase.close();}
    }
});

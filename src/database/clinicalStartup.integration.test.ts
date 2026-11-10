import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {get} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {Sequelize} from 'sequelize';
import {requireMigrationsTestDatabase} from '../../scripts/test-database-migrations-integration.mjs';

const directory = fileURLToPath(new URL('../..', import.meta.url));
const clinicalRelease = '202611050001-clinical-workspace.js';
const precedingReleases = [
    '202610280001-initial-schema.js', '202610280002-appointment-reminders.js',
    '202610310001-quote-package-invoice-lines.js', '202610310002-activity-recurrences.js'
];
const npmCli = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
    .find((candidate): candidate is string => !!candidate && /npm-cli\.js$/i.test(candidate) && existsSync(candidate));

type Running = {child: ChildProcess; output(): string; done: Promise<number | null>};
function launch(args: string[], cwd = directory, environment = process.env): Running {
    assert.ok(npmCli, 'Run through npm or install npm beside the Node executable');
    const child = spawn(process.execPath, [npmCli, ...args], {cwd,
        env: {...environment, PORT: '0'}, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    child.stdout!.on('data', chunk => {output += String(chunk);});
    child.stderr!.on('data', chunk => {output += String(chunk);});
    const done = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
    });
    void done.catch(() => {});
    return {child, output: () => output, done};
}
async function stop(running: Running) {
    const {child} = running;
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        // Stop only the npm process tree created by this test, including its dev watcher.
        if (process.platform === 'win32') {
            const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
            await new Promise<void>((resolve, reject) => {
                killer.once('error', reject);
                killer.once('close', code => code === 0 || child.exitCode !== null || child.signalCode !== null
                    ? resolve() : reject(new Error('Could not stop owned npm process tree ' + child.pid)));
            });
        } else {
            try {process.kill(-child.pid, 'SIGKILL');}
            catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}
        }
    }
    await running.done;
}
async function finished(running: Running) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const code = await Promise.race([running.done, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('npm command timed out: ' + running.output())), 90000);
        })]);
        return {code, output: running.output()};
    } finally {clearTimeout(timer); await stop(running);}
}
function health(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const request = get('http://127.0.0.1:' + port + '/health', response => {
            response.resume(); resolve(response.statusCode ?? 0);
        });
        request.once('error', reject);
        request.setTimeout(1000, () => request.destroy(new Error('Health request timed out')));
    });
}
async function waitUntilHealthy(running: Running) {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline && running.child.exitCode === null && running.child.signalCode === null) {
        const port = running.output().match(/listening on 0\.0\.0\.0:(\d+)/)?.[1];
        if (port) {
            try {if (await health(Number(port)) === 200) return;} catch { /* Startup is still in progress. */ }
        }
        await delay(50);
    }
    throw new Error('Automatic startup did not become healthy: ' + running.output());
}

test('actual dev command stops before migrations when its build fails', {timeout: 100000}, async () => {
    const scripts = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).scripts;
    const fixtureDirectory = mkdtempSync(join(tmpdir(), 'rehablo-dev-build-failure-'));
    try {
        // Keep the real command; replace only its dependencies in an isolated temporary package.
        writeFileSync(join(fixtureDirectory, 'package.json'), JSON.stringify({private: true, scripts: {
            dev: scripts.dev,
            build: 'node -e "console.error(\'EXPECTED_BUILD_FAILURE\');process.exit(23)"',
            'db:migrate': 'node -e "require(\'node:fs\').writeFileSync(\'migration-started\',\'unexpected\')"'
        }}));
        const result = await finished(launch(['run', 'dev'], fixtureDirectory));
        assert.equal(result.code, 23, result.output);
        assert.match(result.output, /EXPECTED_BUILD_FAILURE/);
        assert.equal(existsSync(join(fixtureDirectory, 'migration-started')), false);
        assert.doesNotMatch(result.output, /\[rehablo-api\] listening|bootstrap complete/);
    } finally {
        const marker = join(fixtureDirectory, 'migration-started');
        if (existsSync(marker)) unlinkSync(marker);
        unlinkSync(join(fixtureDirectory, 'package.json'));
        rmdirSync(fixtureDirectory);
    }
});

test('dev and production startup migrate the preceding clinical release automatically and preserve history',
    {timeout: 360000}, async t => {
    const target = requireMigrationsTestDatabase(process.env);
    Object.assign(process.env, {DATABASE_URL: target.databaseUrl, NODE_ENV: 'test', DB_SSL: 'false',
        JWT_SECRET: randomBytes(32).toString('hex'), DEVICE_CREDENTIALS_SECRET: randomBytes(32).toString('hex'),
        BACKGROUND_JOBS_ENABLED: 'false', ACTIVITIES_DELIVERY_ENABLED: 'false', REMINDER_EXTERNAL_DELIVERY_ENABLED: 'false'});
    assert.ok(existsSync(join(directory, 'dist/server.js')), 'Build the deployment artifact before this test');
    const {schemaBaseline} = await import('./schemaBaseline.js');
    const {requiredMigrationNames} = await import('./migrationStatus.js');
    const {sequelize: modelDatabase} = await import('../config/database.js');
    const database = new Sequelize(target.databaseUrl, {dialect: 'postgres', logging: false,
        dialectOptions: {ssl: false}, pool: {max: 2, min: 0}});
    const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    const knownTables = new Set([...schemaBaseline.public.map(table => table.name),
        'SequelizeMeta', 'platform_schema_migrations', 'auth_schema_migrations', 'auth_security_migrations',
        'activity_notification_migrations', 'activity_notification_preferences', 'account_action_tokens']);
    const knownEnums = new Set(schemaBaseline.public.flatMap(table => table.enums.flatMap(sql =>
        [...sql.matchAll(/CREATE TYPE "public"\."([^"]+)"/g)].map(match => match[1]))));
    const metadata = async (schema = 'public') => {
        const [rows] = await database.query('SELECT name FROM ' + quote(schema) + '."SequelizeMeta" ORDER BY name');
        return (rows as Array<{name: string}>).map(row => row.name);
    };
    const runCliTo = async (release: string) => {
        const result = await finished(launch(['run', 'db:migrate', '--', '--to', release]));
        assert.equal(result.code, 0, result.output);
    };
    try {
        await database.authenticate();
        const [identity] = await database.query('SELECT current_database() AS name');
        assert.equal((identity[0] as {name: string}).name, target.databaseName);
        for (const mode of ['dev', 'start'] as const) {
            await t.test('npm ' + (mode === 'dev' ? 'run dev' : 'start') + ' upgrades a genuinely pre-clinical tenant', async t => {
                const [existing] = await database.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
                const [existingEnums] = await database.query("SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e'");
                assert.equal(existing.length, 0, 'Clinical startup tests require an empty disposable database');
                assert.equal(existingEnums.length, 0, 'Clinical startup tests require no existing public enums');
                const tenantId = randomUUID(), structureId = randomUUID(), patientId = randomUUID();
                const userId = randomUUID(), evaluationId = randomUUID(), pointId = randomUUID();
                const schema = 'rehablo_' + tenantId.replaceAll('-', '');
                const prefix = quote(schema);
                const args = mode === 'dev' ? ['run', 'dev'] : ['start'];
                const environment = {...process.env, NODE_ENV: mode === 'dev' ? 'development' : 'production'};
                const snapshot = async () => {
                    const [patients] = await database.query('SELECT * FROM ' + prefix + '.patients ORDER BY id');
                    const [evaluations] = await database.query(`SELECT id,"patientId","userId",date,title,notes,status,"publishedToPatient","createdAt","updatedAt" FROM ${prefix}.evaluations ORDER BY id`);
                    const [points] = await database.query('SELECT * FROM ' + prefix + '.human_body_points ORDER BY id');
                    const [symptoms] = await database.query('SELECT * FROM ' + prefix + '.human_body_symptoms ORDER BY id');
                    const [history] = await database.query('SELECT version,"appliedAt" FROM ' + prefix + '.schema_migrations ORDER BY version');
                    return {patients, evaluations, points, symptoms, history};
                };
                const clinicalColumns = async () => {
                    const [rows] = await database.query(`SELECT column_name FROM information_schema.columns
                        WHERE table_schema=:schema AND table_name='evaluations'
                        AND column_name IN ('carePathId','templateVersionId','configurationSnapshot','clinicalVisibility') ORDER BY column_name`,
                        {replacements: {schema}});
                    return rows;
                };
                const children = new Set<Running>();
                try {
                    // The initial CLI release creates public storage. Register the tenant before the
                    // remaining old releases so their real baseline path creates its old schema.
                    await runCliTo(precedingReleases[0]);
                    await database.query(`INSERT INTO public.tenants(id,license,"idStripe","maxUserQuantity","maxStructureQuantity","createdAt","updatedAt")
                        VALUES (:id,'synthetic-clinical-startup','synthetic',1,1,NOW(),NOW())`, {replacements: {id: tenantId}});
                    await database.query(`INSERT INTO public.structures(id,"tenantId",name,"createdAt","updatedAt")
                        VALUES (:id,:tenant,'Synthetic clinical structure',NOW(),NOW())`, {replacements: {id: structureId, tenant: tenantId}});
                    await runCliTo(precedingReleases[3]);
                    assert.deepEqual(await metadata(), precedingReleases);
                    assert.deepEqual(await metadata(schema), precedingReleases);
                    assert.deepEqual(await clinicalColumns(), []);
                    const [beforeTables] = await database.query('SELECT to_regclass(:table) AS name', {replacements: {table: schema + '.care_paths'}});
                    assert.deepEqual(beforeTables, [{name: null}]);
                    await database.query(`INSERT INTO ${prefix}.patients
                        (id,"tenantId","userId","structureId",name,surname,emails,"phoneNumbers","createdAt","updatedAt")
                        VALUES (:id,:tenant,:user,:structure,'Synthetic patient','Preserved',ARRAY['{"email":"fixture@example.invalid"}'::jsonb],
                        ARRAY['{"number":"0000000000","label":"mobile"}'::jsonb],NOW(),NOW())`,
                        {replacements: {id: patientId, tenant: tenantId, user: userId, structure: structureId}});
                    await database.query(`INSERT INTO ${prefix}.evaluations
                        (id,"patientId","userId",date,title,notes,status,"publishedToPatient","createdAt","updatedAt")
                        VALUES (:id,:patient,:user,'2026-10-30T10:00:00Z','Historical evaluation','Preserve notes','COMPLETED',false,NOW(),NOW())`,
                        {replacements: {id: evaluationId, patient: patientId, user: userId}});
                    await database.query(`INSERT INTO ${prefix}.human_body_points
                        (id,"patientId","userId","evaluationId","cxCoordinate","cyCoordinate","rDimension","bodyPart","fillColor","idSvg","createdAt","updatedAt")
                        VALUES (:id,:patient,:user,:evaluation,25.5,40.5,5,'KNEE','#123456','historical-point',NOW(),NOW())`,
                        {replacements: {id: pointId, patient: patientId, user: userId, evaluation: evaluationId}});
                    for (const value of [0, 7]) {
                        await database.query(`INSERT INTO ${prefix}.human_body_symptoms
                            (id,"humanBodyPointId","evaluationId",symptom,"bodyPart",value,date,"patientId","userId","createdAt","updatedAt")
                            VALUES (:id,:point,:evaluation,'Historical pain','KNEE',:value,'2026-10-30T10:00:00Z',:patient,:user,NOW(),NOW())`,
                            {replacements: {id: randomUUID(), point: pointId, evaluation: evaluationId, value, patient: patientId, user: userId}});
                    }
                    const before = await snapshot();
                    await t.test('a real migration error prevents the API and leaves clinical receipts pending', async () => {
                        // An owned incompatible table fails after earlier clinical DDL has run, testing rollback.
                        await database.query('CREATE TABLE ' + prefix + '.clinical_records (id UUID PRIMARY KEY)');
                        const result = await finished(launch(args, directory, environment));
                        assert.equal(result.code, 1, result.output);
                        assert.match(result.output, /carePathId/);
                        assert.doesNotMatch(result.output, /\[rehablo-api\] listening|bootstrap complete|202611050001-clinical-workspace: migrated/);
                        assert.deepEqual(await metadata(), precedingReleases);
                        assert.deepEqual(await metadata(schema), precedingReleases);
                        assert.deepEqual(await clinicalColumns(), []);
                        const [tables] = await database.query('SELECT to_regclass(:table) AS name', {replacements: {table: schema + '.care_paths'}});
                        assert.deepEqual(tables, [{name: null}], 'Failed clinical DDL must roll back');
                        assert.deepEqual(await snapshot(), before);
                        await database.query('DROP TABLE ' + prefix + '.clinical_records');
                    });
                    await t.test('the same command migrates successfully and then serves the API', async () => {
                        const running = launch(args, directory, environment);
                        children.add(running);
                        try {
                            await waitUntilHealthy(running);
                            assert.match(running.output(), /202611050001-clinical-workspace: migrated/);
                            assert.deepEqual(await metadata(), requiredMigrationNames);
                            assert.deepEqual(await metadata(schema), requiredMigrationNames);
                            assert.ok((await metadata()).includes(clinicalRelease));
                            assert.equal((await clinicalColumns()).length, 4);
                            const [columns] = await database.query(`SELECT table_name,column_name,is_nullable FROM information_schema.columns
                                WHERE table_schema=:schema AND ((table_name='test_instances' AND column_name IN ('humanBodyPointId','testSnapshot'))
                                OR (table_name='human_body_symptoms' AND column_name='value')) ORDER BY table_name,column_name`, {replacements: {schema}});
                            assert.deepEqual(columns, [
                                {table_name: 'human_body_symptoms', column_name: 'value', is_nullable: 'YES'},
                                {table_name: 'test_instances', column_name: 'humanBodyPointId', is_nullable: 'YES'},
                                {table_name: 'test_instances', column_name: 'testSnapshot', is_nullable: 'YES'}
                            ]);
                            const [labels] = await database.query(`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
                                JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=:schema AND t.typname='enum_observations_side' ORDER BY e.enumsortorder`,
                                {replacements: {schema}});
                            assert.deepEqual(labels, ['LEFT', 'RIGHT', 'BILATERAL', 'UNSPECIFIED'].map(enumlabel => ({enumlabel})));
                            assert.deepEqual(await snapshot(), before);
                        } finally {await stop(running); children.delete(running);}
                    });
                    await t.test('a second startup skips completed migrations and preserves history', async () => {
                        const running = launch(args, directory, environment);
                        children.add(running);
                        try {
                            await waitUntilHealthy(running);
                            assert.match(running.output(), /No migrations were executed/);
                            assert.deepEqual(await metadata(), requiredMigrationNames);
                            assert.deepEqual(await metadata(schema), requiredMigrationNames);
                            assert.deepEqual(await snapshot(), before);
                        } finally {await stop(running); children.delete(running);}
                    });
                } finally {
                    for (const child of children) await stop(child);
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
            });
        }
    } finally {await database.close(); await modelDatabase.close();}
});

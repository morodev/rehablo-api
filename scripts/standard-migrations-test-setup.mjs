import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const directory = fileURLToPath(new URL('..', import.meta.url));

/** Execute the real deployment CLI after a test suite has selected its disposable database. */
export async function runStandardMigrations(databaseUrl) {
    const target = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(target.protocol)
        || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
        || !/^[a-z][a-z0-9_]*_(?:activities|financial|migrations)_test(?:_[a-z0-9_]+)?$/.test(decodeURIComponent(target.pathname.slice(1)))) {
        throw new Error('Standard migration test setup requires an explicit disposable local test database');
    }
    const child = spawn(process.execPath, [require.resolve('sequelize-cli/lib/sequelize'), 'db:migrate',
        '--config', 'migrations/config.cjs', '--migrations-path', 'migrations/releases'], {
        cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: {...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test', DB_SSL: 'false'}
    });
    let output = '';
    child.stdout.on('data', chunk => {output += String(chunk);});
    child.stderr.on('data', chunk => {output += String(chunk);});
    const timer = setTimeout(() => child.kill(), 120000);
    try {
        await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', code => code === 0 ? resolve()
                : reject(new Error('Standard Sequelize migration setup failed: ' + output)));
        });
        return output;
    } finally {clearTimeout(timer);}
}

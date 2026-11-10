import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {it} from 'node:test';
import {runBaseline, validateScenario} from './performance-baseline.mjs';
it('refuses remote, authenticated origins and mutating scenarios before making requests', async () => {
    for (const baseUrl of ['https://example.invalid', 'http://secret@localhost:3000', 'http://localhost:3000/redirect']) {
        await assert.rejects(runBaseline({baseUrl, scenario: [{name: 'agenda', path: '/agenda'}], requests: 1, warmup: 0}));
    }
    assert.throws(() => validateScenario([{name: 'write', path: '/patient', method: 'POST'}]));
    assert.throws(() => validateScenario([{name: 'redirect', path: '//example.invalid'}]));
});
it('reports percentiles, errors and sizes without response bodies, auth or sensitive URLs', async () => {
    let seen = 0;
    const server = createServer((req, res) => {
        assert.equal(req.headers.authorization, 'Bearer synthetic-secret');
        seen++;
        res.statusCode = seen === 2 ? 503 : 200;
        res.setHeader('Server-Timing', 'app;dur=8, db_sum;dur=3;desc=private-patient');
        res.setHeader('X-Request-Id', '10000000-0000-4000-8000-000000000001');
        res.end('synthetic-patient-record');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const address = server.address();
        const result = await runBaseline({baseUrl: 'http://127.0.0.1:' + address.port,
            scenario: [{name: 'agenda', path: '/agenda?patient=synthetic-sensitive-id'}], token: 'synthetic-secret',
            requests: 3, concurrency: 1, warmup: 0, includeCorrelation: true});
        assert.equal(result.endpoints[0].samples, 3);
        assert.equal(result.endpoints[0].successCount, 2);
        assert.deepEqual(result.endpoints[0].statuses, {'200': 2, '503': 1});
        assert.equal(result.endpoints[0].serverTimingMs.db_sum.p95, 3);
        assert.ok(result.endpoints[0].decodedResponseBytes.p50 > 0);
        assert.ok(result.endpoints[0].allDurationMs.p99 >= result.endpoints[0].allDurationMs.p50);
        assert.equal(result.correlations.length, 3);
        assert.ok(!/synthetic-secret|synthetic-sensitive-id|patient-record|private-patient|Bearer/.test(JSON.stringify(result)));
    } finally {await new Promise(resolve => server.close(resolve));}
});


async function withLocalServer(handler, test) {
    const server = createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {return await test('http://127.0.0.1:' + server.address().port);}
    finally {
        const closed = new Promise(resolve => server.close(resolve));
        server.closeAllConnections();
        await closed;
    }
}
const syntheticScenario = [{name: 'synthetic', path: '/synthetic'}];

it('validates offered rates and keeps the loopback guard in offered mode', async () => {
    for (const rate of [0, -1, '', 'NaN', Infinity, 0.01, 10001]) {
        await assert.rejects(runBaseline({baseUrl: 'http://127.0.0.1:1', scenario: syntheticScenario,
            requests: 1, warmup: 0, rate}), /offered rate/);
    }
    await assert.rejects(runBaseline({baseUrl: 'https://example.invalid', scenario: syntheticScenario,
        requests: 1, warmup: 0, rate: 10}), /loopback/);
});

it('preserves closed-loop completion, concurrency and throughput without --rate', async () => {
    let active = 0;
    let peak = 0;
    await withLocalServer((_req, res) => {
        peak = Math.max(peak, ++active);
        setTimeout(() => {active--; res.end('{}');}, 50);
    }, async baseUrl => {
        const result = await runBaseline({baseUrl, scenario: syntheticScenario,
            requests: 4, concurrency: 2, warmup: 0});
        assert.equal(result.config.mode, 'closed-loop');
        assert.equal(result.config.rate, undefined);
        assert.equal(result.load.offered, 4);
        assert.equal(result.load.completed, 4);
        assert.equal(result.load.succeeded, 4);
        assert.equal(result.load.failed, 0);
        assert.equal(result.load.dropped, 0);
        assert.equal(result.load.targetRequestsPerSecond, null);
        assert.equal(result.requestsPerSecond, result.load.completedRequestsPerSecond);
        assert.equal(result.load.schedulingLagMs.max, 0);
        assert.equal(peak, 2);
        assert.equal(result.endpoints[0].allDurationMs.p50, result.endpoints[0].requestDurationMs.p50);
    });
});

it('offers a fixed rate over a full window and separates failures from achieved successful RPS', async () => {
    let count = 0;
    await withLocalServer((_req, res) => {
        res.statusCode = ++count === 2 ? 503 : 200;
        res.end('{}');
    }, async baseUrl => {
        const result = await runBaseline({baseUrl, scenario: syntheticScenario,
            requests: 3, concurrency: 3, warmup: 0, rate: 10});
        assert.equal(result.config.mode, 'offered-rate');
        assert.equal(result.config.rate, 10);
        assert.equal(result.load.offeringWindowMs, 300);
        assert.ok(result.elapsedMs >= 299);
        assert.equal(result.load.offeredRequestsPerSecond, 10);
        assert.equal(result.load.offered, 3);
        assert.equal(result.load.completed, 3);
        assert.equal(result.load.succeeded, 2);
        assert.equal(result.load.failed, 1);
        assert.equal(result.load.dropped, 0);
        assert.ok(result.load.achievedRequestsPerSecond < result.load.completedRequestsPerSecond);
        assert.equal(result.endpoints[0].failedCount, 1);
        assert.equal(result.endpoints[0].offeredCount, 3);
    });
});

it('keeps offered arrivals independent of slow completions and drops at the in-flight limit', async () => {
    let active = 0;
    let peak = 0;
    await withLocalServer((_req, res) => {
        peak = Math.max(peak, ++active);
        setTimeout(() => {active--; res.end('{}');}, 250);
    }, async baseUrl => {
        const result = await runBaseline({baseUrl, scenario: syntheticScenario,
            requests: 12, concurrency: 2, warmup: 0, rate: 100});
        assert.equal(result.load.offered, 12);
        assert.equal(result.load.offeredRequestsPerSecond, 100);
        assert.equal(result.load.peakInFlight, 2);
        assert.ok(peak <= 2);
        assert.ok(result.load.dropped > 0, 'slow completions must not postpone offered arrivals');
        assert.equal(result.load.offered, result.load.completed + result.load.dropped);
        assert.equal(result.load.failed, 0);
        assert.equal(result.load.completed, result.load.succeeded);
        assert.ok(result.load.achievedRequestsPerSecond < 100);
        assert.equal(result.endpoints[0].droppedCount, result.load.dropped);
        assert.notEqual(result.endpoints[0].droppedSchedulingLagMs.max, null);
    });
});

it('includes event-loop scheduling lag in each admitted latency without hiding delayed arrivals', async () => {
    let blocker;
    let seen = false;
    const routes = Array.from({length: 6}, (_, index) => ({name: 'arrival-' + index, path: '/arrival-' + index}));
    try {
        await withLocalServer((_req, res) => {
            if (!seen) {
                seen = true;
                blocker = setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 180), 20);
            }
            res.end('{}');
        }, async baseUrl => {
            const result = await runBaseline({baseUrl, scenario: routes,
                requests: 6, concurrency: 6, warmup: 0, rate: 20});
            assert.equal(result.load.dropped, 0);
            assert.equal(result.load.completed, 6);
            assert.ok(result.load.schedulingLagMs.max >= 70, 'fixture must reproduce a delayed scheduler');
            const delayed = result.endpoints.find(row => row.schedulingLagMs.max >= 70);
            assert.ok(delayed);
            assert.ok(Math.abs(delayed.allDurationMs.p50 - delayed.requestDurationMs.p50
                - delayed.schedulingLagMs.p50) < .03, 'latency starts at the original scheduled instant');
            assert.ok(delayed.firstByteMs.p50 >= delayed.schedulingLagMs.p50);
        });
    } finally {clearTimeout(blocker);}
});

it('returns CLI exit 1 for dropped arrivals even when every HTTP response succeeds', async () => {
    const {spawn} = await import('node:child_process');
    const {mkdtemp, writeFile, unlink, rmdir} = await import('node:fs/promises');
    const {tmpdir} = await import('node:os');
    const {join} = await import('node:path');
    const {fileURLToPath} = await import('node:url');
    const directory = await mkdtemp(join(tmpdir(), 'performance-runner-'));
    const scenarioPath = join(directory, 'synthetic.json');
    try {
        await writeFile(scenarioPath, JSON.stringify(syntheticScenario));
        await withLocalServer((_req, res) => setTimeout(() => res.end('{}'), 250), async baseUrl => {
            const child = spawn(process.execPath, [fileURLToPath(new URL('./performance-baseline.mjs', import.meta.url)),
                '--base-url', baseUrl, '--scenario', scenarioPath, '--requests', '10', '--concurrency', '1',
                '--warmup', '0', '--rate', '100'], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
            let output = '';
            let error = '';
            child.stdout.on('data', value => {output += value;});
            child.stderr.on('data', value => {error += value;});
            const code = await new Promise((resolve, reject) => {child.on('error', reject); child.on('close', resolve);});
            assert.equal(code, 1, error);
            const result = JSON.parse(output);
            assert.ok(result.load.dropped > 0);
            assert.equal(result.load.failed, 0);
            assert.equal(result.load.succeeded, result.load.completed);
        });
    } finally {await unlink(scenarioPath); await rmdir(directory);}
});

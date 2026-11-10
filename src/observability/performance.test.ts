import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {it} from 'node:test';
import {instrumentDatabase, measurePerformancePhase, performanceRoute, requestPerformance, type RequestPerformanceRecord} from './performance.js';

function response() {
    const res: any = new EventEmitter();
    const headers = new Map<string, unknown>();
    Object.assign(res, {statusCode: 200, writableFinished: false, headersSent: false,
        setHeader(name: string, value: unknown) {headers.set(name.toLowerCase(), value);},
        getHeader(name: string) {return headers.get(name.toLowerCase());},
        writeHead() {this.headersSent = true; return this;}});
    return res;
}
function database() {
    const hooks = new Map<string, (...args: any[]) => unknown>();
    const failure = new Error('private database address and payload must not be logged');
    const db: any = {addHook(name: string, _label: string, handler: (...args: any[]) => unknown) {hooks.set(name, handler);},
        connectionManager: {async getConnection(options: any) {
            await new Promise(resolve => setImmediate(resolve));
            if (options.fail) throw failure;
            return {};
        }}};
    instrumentDatabase(db);
    return {db, failure, async query() {
        const query = {sql: 'SELECT privatePatientName FROM sensitive_table WHERE id=secret'};
        await hooks.get('beforeQuery')!({type: 'SELECT', bind: ['private patient name']}, query);
        await new Promise(resolve => setImmediate(resolve));
        await hooks.get('afterQuery')!({}, query);
    }};
}
function runRequest(count: number, execute: () => Promise<void>) {
    const req: any = {method: 'GET', originalUrl: '/patient/secret?q=private-patient&token=secret',
        body: {clinicalNote: 'private patient name'}, headers: {authorization: 'secret'}, route: {path: '/patient/:patientId'},
        header: () => undefined};
    const res = response();
    let completed!: RequestPerformanceRecord;
    return new Promise<{record: RequestPerformanceRecord; res: any}>((resolve, reject) => {
        requestPerformance({enabled: true, serverTiming: true, onComplete: record => {completed = record;}})(req, res, () => {
            void (async () => {
                for (let index = 0; index < count; index++) await execute();
                res.writeHead(200);
                res.writableFinished = true;
                res.emit('finish');
                res.emit('close');
                resolve({record: completed, res});
            })().catch(reject);
        });
    });
}
it('keeps concurrent request query counts isolated and exports only route templates and aggregate timings', async () => {
    const fixture = database();
    const [one, three] = await Promise.all([runRequest(1, fixture.query), runRequest(3, fixture.query)]);
    assert.equal(one.record.queryCount, 1);
    assert.equal(three.record.queryCount, 3);
    assert.equal(one.record.route, '/patient/:patientId');
    assert.notEqual(one.record.requestId, three.record.requestId);
    assert.equal(one.res.getHeader('X-Request-Id'), one.record.requestId);
    assert.match(one.res.getHeader('Server-Timing'), /^app;dur=.*db_sum;dur=.*pool_sum;dur=/);
    assert.ok(one.record.queryMs >= 0);
    assert.ok(!/secret|private.patient|SELECT|sensitive_table|clinicalNote|authorization/.test(JSON.stringify([one.record, three.record])));
    assert.equal(performanceRoute({route: undefined}), 'unmatched');
});
it('measures failed pool acquisition without swallowing the error or leaking its details', async () => {
    const fixture = database();
    const result = await runRequest(1, async () => {
        await measurePerformancePhase('auth', async () => {
            await assert.rejects(fixture.db.connectionManager.getConnection({fail: true}), error => error === fixture.failure);
        });
    });
    assert.ok(result.record.poolWaitMs > 0);
    assert.ok(result.record.authMs >= result.record.poolWaitMs);
    assert.ok(!JSON.stringify(result.record).includes(fixture.failure.message));
});
it('is quiet and skips measurement when disabled while retaining a generated correlation id', () => {
    const res = response();
    let next = false, reported = false;
    requestPerformance({enabled: false, onComplete: () => {reported = true;}})({} as any, res, () => {next = true;});
    res.emit('finish');
    assert.equal(next, true);
    assert.equal(reported, false);
    assert.match(res.getHeader('X-Request-Id'), /^[0-9a-f-]{36}$/);
    assert.equal(res.getHeader('Server-Timing'), undefined);
});

for (const signal of ['metrics', 'traces'] as const) it('exports only the explicitly selected ' + signal + ' signal', {timeout: 15_000}, async t => {
    const {createServer} = await import('node:http');
    const {metrics, trace} = await import('@opentelemetry/api');
    const {initializePerformanceTelemetry, shutdownPerformanceTelemetry} = await import('./performance.js');
    const exported: string[] = [];
    const collector = createServer((req, res) => {
        exported.push(req.url!);
        req.resume();
        req.on('end', () => {res.writeHead(200, {'content-type': 'application/json'}); res.end('{}');});
    });
    await new Promise<void>(resolve => collector.listen(0, '127.0.0.1', resolve));
    const port = (collector.address() as import('node:net').AddressInfo).port;
    const keys = ['PERFORMANCE_TELEMETRY_ENABLED', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
        'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'OTEL_METRICS_EXPORTER', 'OTEL_TRACES_EXPORTER', 'OTEL_SDK_DISABLED'];
    const original = new Map(keys.map(key => [key, process.env[key]]));
    try {
        for (const key of keys) delete process.env[key];
        process.env.PERFORMANCE_TELEMETRY_ENABLED = 'true';
        process.env[signal === 'metrics' ? 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT' : 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] = 'http://127.0.0.1:' + port + '/v1/' + signal;
        // SDK environment exporters must not silently enable the other signal.
        process.env[signal === 'metrics' ? 'OTEL_TRACES_EXPORTER' : 'OTEL_METRICS_EXPORTER'] = 'console';
        const consoleExport = t.mock.method(console, 'dir', () => {});
        await initializePerformanceTelemetry();
        metrics.getMeter('synthetic-test').createCounter('synthetic.requests').add(1);
        const span = trace.getTracer('synthetic-test').startSpan('synthetic');
        assert.equal(span.isRecording(), signal === 'traces', 'metrics-only must not create a default trace provider');
        span.end();
        await shutdownPerformanceTelemetry();
        assert.deepEqual(exported, ['/v1/' + signal]);
        assert.equal(consoleExport.mock.callCount(), 0);
    } finally {
        await shutdownPerformanceTelemetry();
        await new Promise<void>(resolve => collector.close(() => resolve()));
        metrics.disable(); trace.disable();
        const api = await import('@opentelemetry/api');
        api.context.disable(); api.propagation.disable();
        for (const key of keys) {
            if (original.get(key) === undefined) delete process.env[key];
            else process.env[key] = original.get(key);
        }
    }
});
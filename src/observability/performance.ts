import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {context, metrics, propagation, SpanKind, SpanStatusCode, trace, type Span} from '@opentelemetry/api';
import type {NextFunction, Request, Response} from 'express';
import type {Sequelize} from 'sequelize';

interface RequestMeasurements {
    requestId: string;
    started: number;
    queryCount: number;
    queryMs: number;
    poolWaitMs: number;
    authMs: number;
    billingMs: number;
}
export interface RequestPerformanceRecord {
    event: 'http.performance';
    requestId: string;
    traceId?: string;
    method: string;
    route: string;
    status: number;
    aborted: boolean;
    durationMs: number;
    queryCount: number;
    queryMs: number;
    poolWaitMs: number;
    authMs: number;
    billingMs: number;
    responseBytes?: number;
}
const requests = new AsyncLocalStorage<RequestMeasurements>();
const tracer = trace.getTracer('rehablo.performance');
let instruments: ReturnType<typeof createInstruments> | undefined;
function createInstruments() {
    const meter = metrics.getMeter('rehablo.performance');
    return {
        requestDuration: meter.createHistogram('rehablo.http.duration', {unit: 'ms'}),
        queryCount: meter.createHistogram('rehablo.http.query_count'),
        queryDuration: meter.createHistogram('rehablo.db.query.duration', {unit: 'ms'}),
        poolWait: meter.createHistogram('rehablo.db.pool.wait', {unit: 'ms'}),
        poolFailures: meter.createCounter('rehablo.db.pool.acquire_failures')
    };
}
function measurements() {return instruments ??= createInstruments();}
function enabled() {return process.env.PERFORMANCE_TELEMETRY_ENABLED === 'true';}
const elapsed = (started: number) => performance.now() - started;
const rounded = (value: number) => Math.round(value * 100) / 100;

/** Only Express route templates are eligible; never log URL, query, headers or bodies. */
export function performanceRoute(req: Pick<Request, 'route'>): string {
    return typeof req.route?.path === 'string' ? req.route.path.slice(0, 256) : 'unmatched';
}
export function requestPerformance(options: {
    enabled?: boolean;
    log?: boolean;
    serverTiming?: boolean;
    onComplete?: (record: RequestPerformanceRecord) => void;
} = {}) {
    return (req: Request, res: Response, next: NextFunction) => {
        const requestId = randomUUID();
        res.setHeader('X-Request-Id', requestId);
        if (!(options.enabled ?? enabled())) return next();
        const state: RequestMeasurements = {requestId, started: performance.now(), queryCount: 0, queryMs: 0,
            poolWaitMs: 0, authMs: 0, billingMs: 0};
        const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(req.method) ? req.method : 'OTHER';
        // Deliberately omit baggage/tracestate, authorization, cookies and all URL parameters.
        const parent = propagation.extract(context.active(), {traceparent: req.header('traceparent')});
        const span = tracer.startSpan('HTTP ' + method, {kind: SpanKind.SERVER}, parent);
        let completed = false;
        const finish = (aborted: boolean) => {
            if (completed) return;
            completed = true;
            const route = performanceRoute(req), duration = elapsed(state.started);
            const attributes = {'http.request.method': method, 'http.route': route,
                'http.response.status_code': res.statusCode, 'http.request.aborted': aborted};
            span.updateName(method + ' ' + route);
            span.setAttributes({...attributes, 'rehablo.db.query_count': state.queryCount,
                'rehablo.db.query_ms': state.queryMs, 'rehablo.db.pool_wait_ms': state.poolWaitMs});
            if (res.statusCode >= 500 || aborted) span.setStatus({code: SpanStatusCode.ERROR});
            span.end();
            measurements().requestDuration.record(duration, attributes);
            measurements().queryCount.record(state.queryCount, attributes);
            const length = Number(res.getHeader('content-length'));
            const traceId = span.spanContext().traceId;
            const record: RequestPerformanceRecord = {event: 'http.performance', requestId,
                ...(traceId !== '00000000000000000000000000000000' ? {traceId} : {}),
                method, route, status: res.statusCode, aborted, durationMs: rounded(duration),
                queryCount: state.queryCount, queryMs: rounded(state.queryMs), poolWaitMs: rounded(state.poolWaitMs),
                authMs: rounded(state.authMs), billingMs: rounded(state.billingMs),
                ...(Number.isFinite(length) && length >= 0 ? {responseBytes: length} : {})};
            // A telemetry sink must never change the outcome of an HTTP response.
            try {
                options.onComplete?.(record);
                if (options.log ?? process.env.PERFORMANCE_LOG_REQUESTS === 'true') console.log(JSON.stringify(record));
            } catch { /* Telemetry is best effort. No error payloads enter the logs. */ }
        };
        if (options.serverTiming ?? process.env.PERFORMANCE_SERVER_TIMING === 'true') {
            const writeHead = res.writeHead;
            res.writeHead = function (this: Response, ...args: any[]) {
                if (!res.headersSent) res.setHeader('Server-Timing',
                    'app;dur=' + rounded(elapsed(state.started)) + ', db_sum;dur=' + rounded(state.queryMs)
                    + ', pool_sum;dur=' + rounded(state.poolWaitMs));
                return (writeHead as any).apply(this, args);
            } as typeof res.writeHead;
        }
        res.once('finish', () => finish(false));
        res.once('close', () => finish(!res.writableFinished));
        context.with(trace.setSpan(parent, span), () => requests.run(state, next));
    };
}

export async function measurePerformancePhase<T>(phase: 'auth' | 'billing', operation: () => Promise<T>): Promise<T> {
    const state = requests.getStore();
    if (!state) return operation();
    const started = performance.now(), span = tracer.startSpan(phase);
    try {return await context.with(trace.setSpan(context.active(), span), operation);}
    finally {
        state[phase === 'auth' ? 'authMs' : 'billingMs'] += elapsed(started);
        span.end();
    }
}

const instrumented = new WeakSet<Sequelize>();
/** No SQL text, bind values, result rows, tenant/user identifiers or errors are exported. */
export function instrumentDatabase(database: Sequelize, poolName = 'primary'): void {
    if (instrumented.has(database)) return;
    instrumented.add(database);
    const queries = new WeakMap<object, {started: number; state?: RequestMeasurements; span: Span; operation: string}>();
    database.addHook('beforeQuery', 'performance', (options, query) => {
        if (!enabled() && !requests.getStore()) return;
        const operation = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'UPSERT', 'BULKUPDATE', 'BULKDELETE'].includes(String(options.type))
            ? String(options.type) : 'OTHER';
        const state = requests.getStore();
        if (state) state.queryCount++;
        queries.set(query, {started: performance.now(), state,
            span: tracer.startSpan('db.query', {attributes: {'db.system': 'postgresql', 'db.operation': operation, 'db.pool.name': poolName}}), operation});
    });
    database.addHook('afterQuery', 'performance', (_options, query) => {
        const measurement = queries.get(query);
        if (!measurement) return;
        queries.delete(query);
        const duration = elapsed(measurement.started);
        if (measurement.state) measurement.state.queryMs += duration;
        measurement.span.end();
        measurements().queryDuration.record(duration, {'db.operation': measurement.operation, 'db.pool.name': poolName});
    });
    // The wrapper includes failed/time-out acquisitions, which afterPoolAcquire alone cannot observe.
    const manager = database.connectionManager;
    const acquire = manager.getConnection.bind(manager);
    manager.getConnection = async function (...args: Parameters<typeof acquire>) {
        if (!enabled() && !requests.getStore()) return acquire(...args);
        const started = performance.now(), state = requests.getStore();
        const span = tracer.startSpan('db.pool.acquire', {attributes: {'db.pool.name': poolName}});
        try {return await acquire(...args);}
        catch (error) {
            span.setStatus({code: SpanStatusCode.ERROR});
            measurements().poolFailures.add(1, {'db.pool.name': poolName});
            throw error;
        } finally {
            const duration = elapsed(started);
            if (state) state.poolWaitMs += duration;
            measurements().poolWait.record(duration, {'db.pool.name': poolName});
            span.end();
        }
    };
    // Read pool counters when metrics are collected; connection limits remain unchanged.
    poolReaders.push({name: poolName, read: () => {
        const pool = (manager as unknown as {pool?: {size: number; available: number; using: number; waiting: number}}).pool;
        return pool ? {size: pool.size, available: pool.available, using: pool.using, waiting: pool.waiting} : null;
    }});
}
const poolReaders: Array<{name: string; read: () => {size: number; available: number; using: number; waiting: number} | null}> = [];

let stopTelemetry: (() => Promise<void>) | undefined;
/** Explicit opt-in. No exporter connects until both telemetry and an OTLP endpoint are configured. */
export async function initializePerformanceTelemetry(): Promise<void> {
    if (!enabled() || stopTelemetry) return;
    const traceEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const metricEndpoint = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (traceEndpoint || metricEndpoint) {
        const [{NodeSDK}, {OTLPTraceExporter}, {OTLPMetricExporter}, {PeriodicExportingMetricReader, MetricReader}, {resourceFromAttributes}] = await Promise.all([
            import('@opentelemetry/sdk-node'), import('@opentelemetry/exporter-trace-otlp-http'),
            import('@opentelemetry/exporter-metrics-otlp-http'), import('@opentelemetry/sdk-metrics'), import('@opentelemetry/resources')
        ]);
        // An explicit silent reader prevents SDK env fallback exporters when no metrics endpoint was selected.
        class SilentMetricReader extends MetricReader {
            protected async onForceFlush() {}
            protected async onShutdown() {}
        }
        const sdk = new NodeSDK({
            autoDetectResources: false, resource: resourceFromAttributes({'service.name': 'rehablo-api'}),
            ...(traceEndpoint ? {traceExporter: new OTLPTraceExporter({timeoutMillis: 5000})} : {spanProcessors: []}),
            ...(metricEndpoint ? {metricReaders: [new PeriodicExportingMetricReader({
                exporter: new OTLPMetricExporter({timeoutMillis: 5000}), exportIntervalMillis: 60_000, exportTimeoutMillis: 10_000
            })]} : {metricReaders: [new SilentMetricReader()]}),
            logRecordProcessors: [], instrumentations: []
        });
        sdk.start();
        stopTelemetry = () => sdk.shutdown();
    } else stopTelemetry = async () => {};
    instruments = undefined;
    const meter = metrics.getMeter('rehablo.performance');
    const loop = monitorEventLoopDelay({resolution: 20});
    loop.enable();
    meter.createObservableGauge('rehablo.process.cpu', {unit: 'ms'}).addCallback(result => {
        const usage = process.cpuUsage();
        result.observe(usage.user / 1000, {kind: 'user'});
        result.observe(usage.system / 1000, {kind: 'system'});
    });
    meter.createObservableGauge('rehablo.process.memory', {unit: 'By'}).addCallback(result => {
        const usage = process.memoryUsage();
        result.observe(usage.rss, {kind: 'rss'});
        result.observe(usage.heapUsed, {kind: 'heap_used'});
    });
    meter.createObservableGauge('rehablo.process.event_loop_delay', {unit: 'ms'}).addCallback(result => {
        result.observe(loop.percentile(95) / 1e6, {percentile: 'p95'});
        loop.reset();
    });
    meter.createObservableGauge('rehablo.db.pool.connections').addCallback(result => {
        for (const reader of poolReaders) {
            const values = reader.read();
            if (values) for (const [state, count] of Object.entries(values)) result.observe(count, {'db.pool.name': reader.name, state});
        }
    });
    const shutdown = stopTelemetry;
    stopTelemetry = async () => {loop.disable(); await shutdown();};
}
export async function shutdownPerformanceTelemetry(): Promise<void> {
    const stop = stopTelemetry; stopTelemetry = undefined;
    await stop?.();
}

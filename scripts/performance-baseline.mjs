import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export function validateScenario(value) {
    if (!Array.isArray(value) || !value.length || value.length > 50) throw new Error('Use 1-50 synthetic GET scenarios.');
    const labels = new Set();
    return value.map(entry => {
        if (!entry || !/^[a-z][a-z0-9_.-]{0,63}$/.test(entry.name) || labels.has(entry.name)
            || typeof entry.path !== 'string' || !entry.path.startsWith('/') || entry.path.startsWith('//')
            || (entry.method && entry.method !== 'GET')) throw new Error('Scenarios require unique technical names and relative GET paths.');
        labels.add(entry.name);
        return {name: entry.name, path: entry.path};
    });
}
function bounded(value, fallback, max) {
    if (value === undefined) return fallback;
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error('Invalid load setting.');
    return result;
}
function offeredRate(value) {
    if (value === undefined) return undefined;
    const result = Number(value);
    if (!Number.isFinite(result) || result < 0.1 || result > 10000) throw new Error('Invalid offered rate.');
    return result;
}
const pause = delay => new Promise(resolve => setTimeout(resolve, delay));
async function waitUntil(deadline) {
    // Timers may wake early. Keep the arrival schedule anchored to the original start.
    while (performance.now() < deadline) await pause(deadline - performance.now());
}
const quantile = (sorted, fraction) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
function distribution(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    const round = value => value === null ? null : Math.round(value * 100) / 100;
    return {p50: round(quantile(sorted, .50)), p95: round(quantile(sorted, .95)), p99: round(quantile(sorted, .99)),
        min: sorted.length ? round(sorted[0]) : null, max: sorted.length ? round(sorted.at(-1)) : null};
}
function serverTimings(value) {
    const allowed = new Set(['app', 'db_sum', 'pool_sum']);
    const result = {};
    for (const metric of (value ?? '').split(',')) {
        const [name, ...parameters] = metric.trim().split(';');
        if (!allowed.has(name)) continue;
        const duration = parameters.map(item => /^dur=([0-9]+(?:\.[0-9]+)?)$/.exec(item.trim())).find(Boolean);
        if (duration) result[name] = Number(duration[1]);
    }
    return result;
}
/** Loopback only. Run against an isolated API/database with synthetic data, never a production proxy. */
export async function runBaseline({baseUrl, scenario, requests = 100, concurrency = 1, warmup = 5,
    timeoutMs = 10000, token, includeCorrelation = false, rate}) {
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
        || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
        throw new Error('Only a loopback API origin is permitted.');
    }
    const routes = validateScenario(scenario);
    requests = bounded(requests, 100, 50000); concurrency = bounded(concurrency, 1, 64);
    warmup = warmup === 0 ? 0 : bounded(warmup, 5, 1000); timeoutMs = bounded(timeoutMs, 10000, 120000);
    rate = offeredRate(rate);
    const headers = {'Accept': 'application/json', ...(token ? {'Authorization': 'Bearer ' + token} : {})};
    const execute = async (route, index, plannedAt) => {
        const target = new URL(route.path, base);
        if (target.origin !== base.origin) throw new Error('Scenario must stay on the loopback API.');
        const started = performance.now();
        const latencyOrigin = plannedAt ?? started;
        const schedulingLagMs = Math.max(0, started - latencyOrigin);
        const requestBytesEstimate = Buffer.byteLength('GET ' + route.path + ' HTTP/1.1\r\n'
            + Object.entries(headers).map(([key, value]) => key + ': ' + value + '\r\n').join(''));
        try {
            const response = await fetch(target, {headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs)});
            const firstByteMs = performance.now() - latencyOrigin;
            const decodedBytes = (await response.arrayBuffer()).byteLength;
            const requestId = response.headers.get('x-request-id');
            const finished = performance.now();
            return {name: route.name, index, status: response.status, durationMs: finished - latencyOrigin,
                requestDurationMs: finished - started, schedulingLagMs,
                firstByteMs, decodedBytes, requestBytesEstimate, serverTiming: serverTimings(response.headers.get('server-timing')),
                ...(includeCorrelation && /^[0-9a-f-]{36}$/i.test(requestId ?? '') ? {requestId} : {})};
        } catch (error) {
            const finished = performance.now();
            return {name: route.name, index, status: 0, durationMs: finished - latencyOrigin,
                requestDurationMs: finished - started, schedulingLagMs,
                requestBytesEstimate, error: error?.name === 'TimeoutError' ? 'timeout' : 'network_error', serverTiming: {}};
        }
    };
    for (let index = 0; index < warmup; index++) await execute(routes[index % routes.length], -1);
    let cursor = 0;
    const samples = [];
    const dropped = [];
    let peakInFlight = 0;
    const started = performance.now();
    if (rate === undefined) {
        // Existing closed-loop mode: a worker starts its next request after completion.
        let inFlight = 0;
        await Promise.all(Array.from({length: Math.min(concurrency, requests)}, async () => {
            while (cursor < requests) {
                const index = cursor++;
                peakInFlight = Math.max(peakInFlight, ++inFlight);
                try {samples.push(await execute(routes[index % routes.length], index));}
                finally {inFlight--;}
            }
        }));
    } else {
        const pending = new Set();
        let executionError;
        for (let index = 0; index < requests; index++) {
            const plannedAt = started + index * 1000 / rate;
            await waitUntil(plannedAt);
            const route = routes[index % routes.length];
            if (pending.size >= concurrency) {
                dropped.push({name: route.name, index, schedulingLagMs: Math.max(0, performance.now() - plannedAt)});
                continue;
            }
            // Do not queue arrivals behind slow requests: account for overload explicitly.
            const task = execute(route, index, plannedAt).then(row => samples.push(row), error => {
                executionError ??= error;
            }).finally(() => pending.delete(task));
            pending.add(task);
            peakInFlight = Math.max(peakInFlight, pending.size);
        }
        // Count a complete offered window, then drain already admitted requests.
        await Promise.all([waitUntil(started + requests * 1000 / rate), ...pending]);
        if (executionError) throw executionError;
    }
    const elapsedMs = performance.now() - started;
    const succeeded = samples.filter(row => row.status >= 200 && row.status < 300).length;
    const perSecond = count => Math.round(count * 100000 / elapsedMs) / 100;
    const grouped = routes.map(route => {
        const rows = samples.filter(row => row.name === route.name);
        const successful = rows.filter(row => row.status >= 200 && row.status < 300);
        const missed = dropped.filter(row => row.name === route.name);
        return {name: route.name, offeredCount: rows.length + missed.length, droppedCount: missed.length,
            samples: rows.length, successCount: successful.length, failedCount: rows.length - successful.length,
            statuses: Object.fromEntries([...new Set(rows.map(row => row.status))].map(status => [status, rows.filter(row => row.status === status).length])),
            allDurationMs: distribution(rows.map(row => row.durationMs)),
            successDurationMs: distribution(successful.map(row => row.durationMs)),
            requestDurationMs: distribution(rows.map(row => row.requestDurationMs)),
            schedulingLagMs: distribution(rows.map(row => row.schedulingLagMs)),
            droppedSchedulingLagMs: distribution(missed.map(row => row.schedulingLagMs)),
            firstByteMs: distribution(successful.map(row => row.firstByteMs)),
            decodedResponseBytes: distribution(successful.map(row => row.decodedBytes)),
            requestBytesEstimate: distribution(rows.map(row => row.requestBytesEstimate)),
            serverTimingMs: Object.fromEntries(['app', 'db_sum', 'pool_sum'].map(key =>
                [key, distribution(successful.map(row => row.serverTiming[key]))]))};
    });
    return {target: 'loopback', config: {requests, concurrency, warmup, timeoutMs,
            mode: rate === undefined ? 'closed-loop' : 'offered-rate', ...(rate === undefined ? {} : {rate})},
        elapsedMs: Math.round(elapsedMs), requestsPerSecond: perSecond(samples.length),
        load: {offered: requests, completed: samples.length, succeeded, failed: samples.length - succeeded,
            dropped: dropped.length, peakInFlight,
            offeringWindowMs: Math.round(rate === undefined ? elapsedMs : requests * 1000 / rate),
            targetRequestsPerSecond: rate ?? null,
            offeredRequestsPerSecond: rate ?? perSecond(requests),
            achievedRequestsPerSecond: perSecond(succeeded),
            completedRequestsPerSecond: perSecond(samples.length),
            failedRequestsPerSecond: perSecond(samples.length - succeeded),
            schedulingLagMs: distribution([...samples, ...dropped].map(row => row.schedulingLagMs))},
        endpoints: grouped,
        ...(includeCorrelation ? {correlations: samples.filter(row => row.requestId).map(row =>
            ({name: row.name, index: row.index, requestId: row.requestId}))} : {})};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const {values} = parseArgs({options: {'base-url': {type: 'string'}, scenario: {type: 'string'},
            requests: {type: 'string'}, concurrency: {type: 'string'}, rate: {type: 'string'}, warmup: {type: 'string'}, timeout: {type: 'string'},
            correlation: {type: 'boolean', default: false}}});
        if (!values['base-url'] || !values.scenario) throw new Error('Specify --base-url and --scenario.');
        const scenario = JSON.parse(await readFile(values.scenario, 'utf8'));
        const result = await runBaseline({baseUrl: values['base-url'], scenario,
            requests: values.requests, concurrency: values.concurrency, rate: values.rate, warmup: values.warmup === '0' ? 0 : values.warmup,
            timeoutMs: values.timeout, token: process.env.PERFORMANCE_BEARER_TOKEN, includeCorrelation: values.correlation});
        console.log(JSON.stringify(result, null, 2));
        if (result.load.failed || result.load.dropped) process.exitCode = 1;
    } catch {
        // Do not echo paths, tokens, URLs, parser errors, response bodies or request parameters.
        console.error('Baseline failed. Verify the loopback origin, synthetic scenario file and load options.');
        process.exitCode = 1;
    }
}

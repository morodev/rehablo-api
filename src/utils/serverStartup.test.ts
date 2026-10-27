import assert from 'node:assert/strict';
import {request, type IncomingHttpHeaders, type Server} from 'node:http';
import {createConnection, type AddressInfo} from 'node:net';
import {test, type TestContext} from 'node:test';
import express from 'express';
import {createStartupReadiness, startHttpServer} from './serverStartup.js';

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {promise, resolve, reject};
}

function portOf(server: Server): number {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return address.port;
}

async function closeServer(server: Server): Promise<void> {
    server.closeAllConnections();
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

function send(port: number, path: string, body?: string): Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
}> {
    return new Promise((resolve, reject) => {
        const req = request({
            hostname: '127.0.0.1', port, path,
            method: body === undefined ? 'GET' : 'POST',
            agent: false,
            headers: body === undefined ? {} : {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, res => {
            const chunks: Buffer[] = [];
            res.on('data', chunk => chunks.push(Buffer.from(chunk)));
            res.on('error', reject);
            res.on('end', () => resolve({
                status: res.statusCode!, headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.setTimeout(2000, () => req.destroy(new Error('HTTP test request timed out')));
        req.on('error', reject);
        req.end(body);
    });
}

async function suspendedStartup(t: TestContext, app: express.Express,
    readiness: ReturnType<typeof createStartupReadiness>) {
    const initialized = deferred<void>();
    const listening = deferred<Server>();
    let boundServer: Server | undefined;
    const startup = startHttpServer(app, 0, readiness, async server => {
        boundServer = server;
        listening.resolve(server);
        await initialized.promise;
    });
    // Keep an unexpected failure handled while a test is still checking the listener.
    void startup.catch(() => {});
    t.after(async () => {
        initialized.resolve();
        await startup.catch(() => {});
        if (boundServer) await closeServer(boundServer);
    });
    const server = await Promise.race([listening.promise, startup]);
    return {server, startup, initialized, port: portOf(server)};
}

test('binds before initialization and gates health, shared APIs and webhook parsers until ready',
    {timeout: 10000}, async t => {
        const app = express();
        const readiness = createStartupReadiness();
        const calls = {shared: 0, json: 0, webhook: 0};
        const webhookBodies: Buffer[] = [];
        app.get('/health', readiness.health);
        app.use(readiness.requireReady);
        app.post('/webhook', express.raw({type: 'application/json'}), (req, res) => {
            calls.webhook++;
            assert.ok(Buffer.isBuffer(req.body));
            webhookBodies.push(req.body);
            res.json({received: true});
        });
        app.use(express.json());
        app.get('/api/shared', (_req, res) => {
            calls.shared++;
            res.json({tenants: []});
        });
        app.post('/api/resource', (req, res) => {
            calls.json++;
            res.json(req.body);
        });

        const {server, port, initialized, startup} = await suspendedStartup(t, app, readiness);
        assert.equal((server.address() as AddressInfo).address, '0.0.0.0');
        for (const [path, body] of [
            ['/health', undefined],
            ['/api/shared', undefined],
            ['/api/resource', '{invalid JSON'],
            ['/webhook', '{invalid JSON'],
        ] as const) {
            const response = await send(port, path, body);
            assert.equal(response.status, 503, path);
            assert.deepEqual(JSON.parse(response.body), {status: 'starting'}, path);
        }
        assert.deepEqual(calls, {shared: 0, json: 0, webhook: 0});

        initialized.resolve();
        assert.equal(await startup, server);
        const health = await send(port, '/health');
        assert.equal(health.status, 200);
        assert.deepEqual(JSON.parse(health.body), {status: 'ok'});
        assert.equal((await send(port, '/api/shared')).status, 200);
        const payload = '{\n  "message": "caffè", "count": 2\n}\n';
        const webhook = await send(port, '/webhook', payload);
        assert.equal(webhook.status, 200);
        assert.deepEqual(webhookBodies, [Buffer.from(payload)]);
        const json = await send(port, '/api/resource', '{"value":42}');
        assert.equal(json.status, 200);
        assert.deepEqual(JSON.parse(json.body), {value: 42});
        assert.deepEqual(calls, {shared: 1, json: 1, webhook: 1});
    });

test('initialization failure closes the listener and resets readiness', {timeout: 10000}, async t => {
    const app = express();
    const readiness = createStartupReadiness();
    app.get('/health', readiness.health);
    app.use(readiness.requireReady);
    app.get('/api/shared', (_req, res) => res.json({served: true}));
    const {server, port, initialized, startup} = await suspendedStartup(t, app, readiness);
    const accepted = deferred<void>();
    server.once('connection', () => accepted.resolve());
    const connection = createConnection({host: '127.0.0.1', port});
    t.after(() => connection.destroy());
    await Promise.all([
        accepted.promise,
        new Promise<void>((resolve, reject) => {
            connection.once('connect', resolve);
            connection.once('error', reject);
        }),
    ]);
    const connectionClosed = new Promise<void>(resolve => connection.once('close', () => resolve()));
    const failure = new Error('tenant initialization failed');
    // Readiness must be reset even if another startup step marked it ready prematurely.
    readiness.markReady();
    const rejected = assert.rejects(startup, error => error === failure);
    initialized.reject(failure);
    await rejected;
    await connectionClosed;
    assert.equal(server.listening, false);
    await assert.rejects(send(port, '/health'), (error: NodeJS.ErrnoException) =>
        error.code === 'ECONNREFUSED');

    // A fresh listener permits real HTTP verification of the same readiness state.
    const probe = await new Promise<Server>((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    t.after(() => closeServer(probe));
    for (const path of ['/health', '/api/shared']) {
        const response = await send(portOf(probe), path);
        assert.equal(response.status, 503);
        assert.deepEqual(JSON.parse(response.body), {status: 'starting'});
    }
});

test('an occupied port rejects without initialization and clears stale readiness',
    {timeout: 10000}, async t => {
        const readiness = createStartupReadiness();
        const probeApp = express();
        probeApp.get('/health', readiness.health);
        const occupied = await new Promise<Server>((resolve, reject) => {
            const listener = probeApp.listen(0, '0.0.0.0', () => resolve(listener));
            listener.once('error', reject);
        });
        t.after(() => closeServer(occupied));
        readiness.markReady();
        let initialized = false;
        await assert.rejects(startHttpServer(express(), portOf(occupied), readiness, async () => {
            initialized = true;
        }), (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE');
        assert.equal(initialized, false);
        const health = await send(portOf(occupied), '/health');
        assert.equal(health.status, 503);
        assert.deepEqual(JSON.parse(health.body), {status: 'starting'});
    });

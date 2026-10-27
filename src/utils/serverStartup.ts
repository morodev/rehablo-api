import {createServer, Server} from 'node:http';
import type {Express, RequestHandler, Response} from 'express';

export interface StartupReadiness {
    health: RequestHandler;
    requireReady: RequestHandler;
    markReady(): void;
    markStarting(): void;
}

/** HTTP can listen during bootstrap without exposing partially initialized application routes. */
export function createStartupReadiness(): StartupReadiness {
    let ready = false;
    const starting = (res: Response) => {
        res.set('Cache-Control', 'no-store');
        res.set('Retry-After', '5');
        res.status(503).json({status: 'starting'});
    };
    return {
        health: (_req, res) => {
            if (!ready) return starting(res);
            res.set('Cache-Control', 'no-store');
            res.json({status: 'ok'});
        },
        requireReady: (_req, res, next) => {
            if (!ready) return starting(res);
            next();
        },
        markReady: () => {ready = true;},
        markStarting: () => {ready = false;}
    };
}

/** Resolves only when bootstrap has succeeded; a rejected bootstrap closes the early listener. */
export async function startHttpServer(
    app: Express, port: number, readiness: StartupReadiness,
    initialize: (server: Server) => Promise<void>
): Promise<Server> {
    const server = createServer(app);
    readiness.markStarting();
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, '0.0.0.0', () => {
                server.removeListener('error', reject);
                resolve();
            });
        });
        const address = server.address();
        console.log(`[rehablo-api] listening on 0.0.0.0:${typeof address === 'object' ? address?.port : port}; bootstrap in progress`);
        await initialize(server);
        readiness.markReady();
        console.log('[rehablo-api] bootstrap complete; accepting application traffic');
        return server;
    } catch (error) {
        readiness.markStarting();
        if (server.listening) {
            server.close();
            server.closeAllConnections();
        }
        throw error;
    }
}

export async function runStartupPhase<T>(name: string, operation: () => T | Promise<T>): Promise<T> {
    const started = Date.now();
    console.log(`[startup] ${name}: started`);
    try {
        const result = await operation();
        console.log(`[startup] ${name}: completed in ${Date.now() - started}ms`);
        return result;
    } catch (error) {
        console.error(`[startup] ${name}: failed after ${Date.now() - started}ms`, error);
        throw error;
    }
}

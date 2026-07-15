import { Request, Response } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import DeviceSource from '../models/catalog/deviceSource.model.js';
import MetricDefinition from '../models/catalog/metricDefinition.model.js';
import DeviceConnection from '../models/deviceConnection.model.js';
import type { DeviceConnectionAttributes } from '../models/deviceConnection.model.js';
import { encryptSecret } from '../utils/credentialCrypto.js';

/** Rimuove il segreto cifrato prima di restituire una connessione al client. */
function sanitizeConnection(conn: DeviceConnection) {
    const { credentialsEncrypted, ...rest } = conn.toJSON() as DeviceConnectionAttributes;
    return { ...rest, hasCredentials: Boolean(credentialsEncrypted) };
}

/**
 * Catalogo dispositivi ("Rehablo Certified Devices"): alimenta l'elenco nel frontend da cui l'operatore
 * sceglie il device e il canale (manuale / import / api).
 */
export const catalog = asyncHandler(async (_req: Request, res: Response) => {
    const devices = await DeviceSource.findAll({ where: { isActive: true }, order: [['displayName', 'ASC']] });
    return sendSuccessResponse(res, 200, devices, 'Catalogo dispositivi');
});

/**
 * Metriche prodotte da un dispositivo → il frontend le usa per costruire i CAMPI dell'inserimento
 * MANUALE (con unità, lati e range presi dal dizionario).
 */
export const deviceMetrics = asyncHandler(async (req: Request, res: Response) => {
    const device = await DeviceSource.findOne({ where: { sourceId: req.params.sourceId } });
    if (!device) {
        return sendErrorResponse(res, 404, `Dispositivo "${req.params.sourceId}" non trovato nel catalogo`);
    }
    const codes = device.get('producesMetrics') as string[];
    const metrics = await MetricDefinition.findAll({ where: { code: codes as any } });
    return sendSuccessResponse(res, 200, { device, metrics }, 'Metriche del dispositivo');
});

/**
 * Registra una connessione del CENTRO a un dispositivo. Per i canali API le credenziali del vendor
 * (API key/secret dell'account del centro) vengono CIFRATE prima del salvataggio e mai restituite.
 * Body: { sourceId, label, channel, credentials?, config? }.
 */
export const createConnection = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const tenantId = req.user!.tenants[0].id;
    const { sourceId, label, channel, credentials, config } = req.body as {
        sourceId?: string;
        label?: string;
        channel?: string;
        credentials?: string | Record<string, unknown>;
        config?: Record<string, unknown>;
    };

    if (!sourceId || !label || !channel) {
        return sendErrorResponse(res, 400, 'sourceId, label e channel sono obbligatori');
    }

    const device = await DeviceSource.findOne({ where: { sourceId } });
    if (!device) {
        return sendErrorResponse(res, 404, `Dispositivo "${sourceId}" non presente nel catalogo`);
    }
    if (!(device.get('channels') as string[]).includes(channel)) {
        return sendErrorResponse(res, 400, `Il dispositivo non supporta il canale "${channel}"`);
    }

    const credentialsEncrypted = credentials
        ? encryptSecret(typeof credentials === 'string' ? credentials : JSON.stringify(credentials))
        : null;

    const connection = await DeviceConnection.schema(schema).create({
        tenantId,
        sourceId,
        label,
        channel: channel as any,
        credentialsEncrypted,
        config: config ?? null
    });

    return sendSuccessResponse(res, 201, sanitizeConnection(connection), 'Connessione dispositivo creata');
});

/** Elenco delle connessioni del centro (senza esporre le credenziali). */
export const listConnections = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const connections = await DeviceConnection.schema(schema).findAll({ order: [['label', 'ASC']] });
    return sendSuccessResponse(res, 200, connections.map(sanitizeConnection), 'Connessioni dispositivi');
});

/**
 * Crea o aggiorna un dispositivo del catalogo (per il wizard "aggiungi dispositivo").
 * Upsert per `sourceId`. Body: { sourceId, vendor, model, displayName, deviceType, channels,
 * producesMetrics, integrationLevel?, apiDocsUrl?, notes? }.
 */
export const upsertDevice = asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const sourceId = body.sourceId as string;
    const { vendor, model, displayName, deviceType, channels } = body as {
        vendor?: string;
        model?: string;
        displayName?: string;
        deviceType?: string;
        channels?: string[];
    };

    if (!sourceId || !vendor || !model || !displayName || !deviceType || !Array.isArray(channels) || !channels.length) {
        return sendErrorResponse(
            res,
            400,
            'sourceId, vendor, model, displayName, deviceType e almeno un channel sono obbligatori'
        );
    }

    const defaults = {
        sourceId,
        vendor,
        model,
        displayName,
        deviceType,
        channels: channels as any,
        integrationLevel: (body.integrationLevel as any) ?? 'MANUAL',
        producesMetrics: (body.producesMetrics as any) ?? [],
        importProfileId: (body.importProfileId as any) ?? null,
        apiDocsUrl: (body.apiDocsUrl as any) ?? null,
        notes: (body.notes as any) ?? null
    };

    const existing = await DeviceSource.findOne({ where: { sourceId } });
    if (existing) {
        await existing.update(defaults);
        return sendSuccessResponse(res, 200, existing, 'Dispositivo aggiornato');
    }
    const created = await DeviceSource.create(defaults as any);
    return sendSuccessResponse(res, 201, created, 'Dispositivo creato');
});

export default { catalog, deviceMetrics, upsertDevice, createConnection, listConnections };



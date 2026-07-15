import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../../config/database.js';

/** Canali su cui un dispositivo può conferire dati a Rehablo. */
export type DeviceChannel = 'MANUAL' | 'IMPORT' | 'API_PULL' | 'API_PUSH';

/** Livello di integrazione mostrato all'utente ("Rehablo Certified Devices"). */
export type DeviceIntegrationLevel = 'NATIVE' | 'IMPORT' | 'MANUAL';

export interface DeviceSourceAttributes {
    id: string;
    /** Slug stabile usato ovunque come sorgente, es. "kinvent-kforce". Coincide col sourceId delle mappature. */
    sourceId: string;
    vendor: string;
    model: string;
    displayName: string;
    /** Tipo di apparecchiatura: dynamometer, force-plate, isokinetic, emg, imu... */
    deviceType: string;
    /** Canali supportati da questo dispositivo. */
    channels: DeviceChannel[];
    /** Livello di integrazione (per la UI). */
    integrationLevel: DeviceIntegrationLevel;
    /**
     * Metriche del dizionario che questo dispositivo può produrre (codici MetricDefinition.code).
     * È ciò che il frontend usa per renderizzare i CAMPI dell'inserimento MANUALE.
     */
    producesMetrics: string[];
    /** Se disponibile un import da file, il profilo/mappatura da usare (per ora coincide con sourceId). */
    importProfileId?: string | null;
    /** Per i canali API: base URL della documentazione o dell'endpoint del vendor (informativo). */
    apiDocsUrl?: string | null;
    notes?: string | null;
    isActive: boolean;
}

export type DeviceSourceCreationAttributes = Optional<
    DeviceSourceAttributes,
    'id' | 'integrationLevel' | 'isActive'
>;

/**
 * Catalogo dei dispositivi supportati (schema public, condiviso da tutti i tenant).
 * Risponde a: "quali dati raccoglie il Dinamometro A?" -> `producesMetrics`.
 * "Su quali canali?" -> `channels`. La UI ci costruisce sopra l'elenco "Rehablo Certified Devices".
 */
export class DeviceSource
    extends Model<DeviceSourceAttributes, DeviceSourceCreationAttributes>
    implements DeviceSourceAttributes {
    declare id: string;
    declare sourceId: string;
    declare vendor: string;
    declare model: string;
    declare displayName: string;
    declare deviceType: string;
    declare channels: DeviceChannel[];
    declare integrationLevel: DeviceIntegrationLevel;
    declare producesMetrics: string[];
    declare importProfileId: string | null;
    declare apiDocsUrl: string | null;
    declare notes: string | null;
    declare isActive: boolean;
}

DeviceSource.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        sourceId: { type: DataTypes.STRING, allowNull: false, unique: true },
        vendor: { type: DataTypes.STRING, allowNull: false },
        model: { type: DataTypes.STRING, allowNull: false },
        displayName: { type: DataTypes.STRING, allowNull: false },
        deviceType: { type: DataTypes.STRING, allowNull: false },
        channels: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
        integrationLevel: {
            type: DataTypes.ENUM('NATIVE', 'IMPORT', 'MANUAL'),
            allowNull: false,
            defaultValue: 'MANUAL'
        },
        producesMetrics: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
        importProfileId: { type: DataTypes.STRING, allowNull: true },
        apiDocsUrl: { type: DataTypes.STRING, allowNull: true },
        notes: { type: DataTypes.TEXT, allowNull: true },
        isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
    },
    { sequelize, modelName: 'deviceSource', tableName: 'device_sources', schema: 'public' }
);

export default DeviceSource;


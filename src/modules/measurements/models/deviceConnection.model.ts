import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import type { DeviceChannel } from './catalog/deviceSource.model.js';

export interface DeviceConnectionAttributes {
    id: string;
    tenantId: string;
    /** Dispositivo del catalogo (DeviceSource.sourceId) a cui questa connessione si riferisce. */
    sourceId: string;
    /** Etichetta scelta dal centro, es. "Dinamometro sala 2". */
    label: string;
    /** Canale attivo per questa connessione. */
    channel: DeviceChannel;
    /**
     * Credenziali del vendor (es. API key / client secret dell'account del CENTRO), CIFRATE.
     * Non vengono mai restituite in chiaro: le decifra solo il connettore lato server.
     */
    credentialsEncrypted?: string | null;
    /** Configurazione non segreta (es. baseUrl, teamId, regione). */
    config?: Record<string, unknown> | null;
    /** Ultima sincronizzazione riuscita (per i connettori pull). */
    lastSyncAt?: Date | null;
    active: boolean;
}

export type DeviceConnectionCreationAttributes = Optional<
    DeviceConnectionAttributes,
    'id' | 'active'
>;

/**
 * Connessione di UN centro a UN dispositivo. Tenant-scoped: le credenziali del vendor appartengono al
 * centro (proprietario dei dati) e restano isolate nel suo schema. Il BE si collega al vendor usando
 * queste credenziali (decifrate) tramite il connettore corrispondente al `sourceId`.
 */
export class DeviceConnection
    extends Model<DeviceConnectionAttributes, DeviceConnectionCreationAttributes>
    implements DeviceConnectionAttributes {
    declare id: string;
    declare tenantId: string;
    declare sourceId: string;
    declare label: string;
    declare channel: DeviceChannel;
    declare credentialsEncrypted: string | null;
    declare config: Record<string, unknown> | null;
    declare lastSyncAt: Date | null;
    declare active: boolean;
}

DeviceConnection.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        tenantId: { type: DataTypes.STRING, allowNull: false },
        sourceId: { type: DataTypes.STRING, allowNull: false },
        label: { type: DataTypes.STRING, allowNull: false },
        channel: {
            type: DataTypes.ENUM('MANUAL', 'IMPORT', 'API_PULL', 'API_PUSH'),
            allowNull: false
        },
        credentialsEncrypted: { type: DataTypes.TEXT, allowNull: true },
        config: { type: DataTypes.JSONB, allowNull: true },
        lastSyncAt: { type: DataTypes.DATE, allowNull: true },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
    },
    { sequelize, modelName: 'deviceConnection', tableName: 'device_connections' }
);

export default DeviceConnection;


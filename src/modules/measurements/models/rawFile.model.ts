import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface RawFileAttributes {
    id: string;
    tenantId: string;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    checksumSha256: string;
    /** Percorso relativo alla root dello StorageAdapter (non un path assoluto di filesystem). */
    storagePath: string;
    /** Utente che ha effettuato l'upload. */
    uploadedBy?: string | null;
    uploadedAt: Date;
}

export type RawFileCreationAttributes = Optional<RawFileAttributes, 'id' | 'uploadedAt'>;

/**
 * File grezzo originale (CSV/Excel/PDF/curva) di una misurazione strumentale (F0.1, vedi
 * docs/REHABLO_OS_GAP_ANALYSIS.md §3.3). Tenant-scoped: sempre `RawFile.schema(req.tenantSchema)`.
 * `Observation.rawFileId` referenzia questa tabella in modo logico (nessuna FK cross-schema).
 */
export class RawFile extends Model<RawFileAttributes, RawFileCreationAttributes> implements RawFileAttributes {
    declare id: string;
    declare tenantId: string;
    declare originalName: string;
    declare mimeType: string;
    declare sizeBytes: number;
    declare checksumSha256: string;
    declare storagePath: string;
    declare uploadedBy: string | null;
    declare uploadedAt: Date;
}

RawFile.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        tenantId: { type: DataTypes.STRING, allowNull: false },
        originalName: { type: DataTypes.STRING, allowNull: false },
        mimeType: { type: DataTypes.STRING, allowNull: false },
        sizeBytes: { type: DataTypes.INTEGER, allowNull: false },
        checksumSha256: { type: DataTypes.STRING, allowNull: false },
        storagePath: { type: DataTypes.STRING, allowNull: false },
        uploadedBy: { type: DataTypes.STRING, allowNull: true },
        uploadedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
    },
    {
        sequelize,
        modelName: 'rawFile',
        tableName: 'raw_files',
        indexes: [{ fields: ['tenantId'] }, { fields: ['checksumSha256'] }]
    }
);

export default RawFile;


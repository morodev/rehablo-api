import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface NoteImageAttributes {
    id: string;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    checksumSha256: string;
    storagePath: string;
    ownerUserId: string;
    structureId: string;
    createdByUserId: string;
}

export type NoteImageCreationAttributes = Optional<NoteImageAttributes, 'id'>;

/** Immagini private usate nel contenuto delle note del tenant. */
export class NoteImage extends Model<NoteImageAttributes, NoteImageCreationAttributes> implements NoteImageAttributes {
    declare id: string;
    declare originalName: string;
    declare mimeType: string;
    declare sizeBytes: number;
    declare checksumSha256: string;
    declare storagePath: string;
    declare ownerUserId: string;
    declare structureId: string;
    declare createdByUserId: string;
}

NoteImage.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        originalName: { type: DataTypes.STRING(255), allowNull: false },
        mimeType: { type: DataTypes.STRING(64), allowNull: false },
        sizeBytes: { type: DataTypes.INTEGER, allowNull: false },
        checksumSha256: { type: DataTypes.STRING(64), allowNull: false },
        storagePath: { type: DataTypes.STRING(1024), allowNull: false },
        ownerUserId: { type: DataTypes.UUID, allowNull: false },
        structureId: { type: DataTypes.UUID, allowNull: false },
        createdByUserId: { type: DataTypes.UUID, allowNull: false }
    },
    {
        sequelize,
        modelName: 'noteImage',
        tableName: 'note_images',
        paranoid: true,
        indexes: [
            { fields: ['ownerUserId'] },
            { fields: ['structureId'] }
        ]
    }
);

export default NoteImage;

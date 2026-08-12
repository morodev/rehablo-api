import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export type NoteType = 'CLINICAL' | 'ADMIN' | 'INTERNAL';

export interface NoteAttributes {
    id: string;
    type: NoteType;
    title: string;
    contentHtml?: string | null;
    contentText?: string | null;
    contentDelta?: Record<string, unknown> | null;
    patientId?: string | null;
    agendaEventId?: string | null;
    evaluationId?: string | null;
    ownerUserId: string;
    structureId?: string | null;
    createdByUserId: string;
    updatedByUserId?: string | null;
    pinned: boolean;
    archived: boolean;
}

export type NoteCreationAttributes = Optional<
    NoteAttributes,
    'id' | 'type' | 'pinned' | 'archived' | 'contentHtml' | 'contentText' | 'contentDelta'
>;

/** Tenant-scoped notes. Always access through `Note.schema(req.tenantSchema)`. */
export class Note extends Model<NoteAttributes, NoteCreationAttributes> implements NoteAttributes {
    declare id: string;
    declare type: NoteType;
    declare title: string;
    declare contentHtml: string | null;
    declare contentText: string | null;
    declare contentDelta: Record<string, unknown> | null;
    declare patientId: string | null;
    declare agendaEventId: string | null;
    declare evaluationId: string | null;
    declare ownerUserId: string;
    declare structureId: string | null;
    declare createdByUserId: string;
    declare updatedByUserId: string | null;
    declare pinned: boolean;
    declare archived: boolean;
}

Note.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        type: {
            type: DataTypes.ENUM('CLINICAL', 'ADMIN', 'INTERNAL'),
            allowNull: false,
            defaultValue: 'CLINICAL'
        },
        title: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
        contentHtml: { type: DataTypes.TEXT, allowNull: true },
        contentText: { type: DataTypes.TEXT, allowNull: true },
        contentDelta: { type: DataTypes.JSONB, allowNull: true },
        patientId: { type: DataTypes.UUID, allowNull: true },
        agendaEventId: { type: DataTypes.UUID, allowNull: true },
        evaluationId: { type: DataTypes.UUID, allowNull: true },
        ownerUserId: { type: DataTypes.UUID, allowNull: false },
        structureId: { type: DataTypes.UUID, allowNull: true },
        createdByUserId: { type: DataTypes.UUID, allowNull: false },
        updatedByUserId: { type: DataTypes.UUID, allowNull: true },
        pinned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        archived: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }
    },
    {
        sequelize,
        modelName: 'note',
        tableName: 'notes',
        paranoid: true
    }
);

export default Note;

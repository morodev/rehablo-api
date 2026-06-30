import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface PatientAttributes {
    id: string;
    tenantId: string;
    userId: string;
    isShared: boolean;
    sharedWith: number[];
    name: string;
    surname?: string | null;
    placeBirth?: string | null;
    birthday?: Date | null;
    fiscalCode?: string | null;
    gender?: 'MALE' | 'FEMALE' | 'OTHER' | null;
    work?: string | null;
    hobby?: string | null;
    sport?: string | null;
    title?: string | null;
    address?: string | null;
    emails: Record<string, unknown>[];
    tags: string[];
    phoneNumbers: Record<string, unknown>[];
    background: string;
    notes?: string | null;
}

export type PatientCreationAttributes = Optional<
    PatientAttributes,
    'id' | 'isShared' | 'sharedWith' | 'emails' | 'tags' | 'phoneNumbers' | 'background' | 'name'
>;

/**
 * NOTE: this model is intentionally NOT tied to a fixed schema. Every query must go through
 * `Patient.schema(req.tenantSchema)` (see `resolveTenantSchema` middleware), reproducing the
 * per-tenant Postgres schema isolation used in the former rehablo-patient-registry service.
 */
export class Patient extends Model<PatientAttributes, PatientCreationAttributes> implements PatientAttributes {
    declare id: string;
    declare tenantId: string;
    declare userId: string;
    declare isShared: boolean;
    declare sharedWith: number[];
    declare name: string;
    declare surname: string | null;
    declare placeBirth: string | null;
    declare birthday: Date | null;
    declare fiscalCode: string | null;
    declare gender: 'MALE' | 'FEMALE' | 'OTHER' | null;
    declare work: string | null;
    declare hobby: string | null;
    declare sport: string | null;
    declare title: string | null;
    declare address: string | null;
    declare emails: Record<string, unknown>[];
    declare tags: string[];
    declare phoneNumbers: Record<string, unknown>[];
    declare background: string;
    declare notes: string | null;
}

Patient.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        tenantId: { type: DataTypes.STRING, allowNull: false },
        userId: { type: DataTypes.STRING, allowNull: false },
        isShared: { type: DataTypes.BOOLEAN, defaultValue: false },
        sharedWith: { type: DataTypes.ARRAY(DataTypes.INTEGER), defaultValue: [] },
        name: { type: DataTypes.STRING, defaultValue: '' },
        surname: DataTypes.STRING,
        placeBirth: DataTypes.STRING,
        birthday: DataTypes.DATE,
        fiscalCode: DataTypes.STRING,
        gender: DataTypes.ENUM('MALE', 'FEMALE', 'OTHER'),
        work: DataTypes.STRING,
        hobby: DataTypes.STRING,
        sport: DataTypes.STRING,
        title: DataTypes.STRING,
        address: DataTypes.STRING,
        emails: { type: DataTypes.ARRAY(DataTypes.JSON), defaultValue: [] },
        tags: { type: DataTypes.ARRAY(DataTypes.STRING), defaultValue: [] },
        phoneNumbers: { type: DataTypes.ARRAY(DataTypes.JSON), defaultValue: [] },
        background: { type: DataTypes.STRING, defaultValue: 'assets/images/cards/17-640x480.jpg' },
        notes: DataTypes.TEXT
    },
    { sequelize, modelName: 'patient', tableName: 'patients' }
);

export default Patient;


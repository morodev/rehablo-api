import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface TenantAttributes {
    id: string;
    businessName?: string | null;
    VATNumber?: string | null;
    license: string;
    isActive: boolean;
    idStripe: string;
    isPremium: boolean;
    userQuantity: number;
    maxUserQuantity: number;
    structureQuantity: number;
    maxStructureQuantity: number;
    MBQuantity: number;
    // --- Dati fiscali obbligatori per l'invio dati al Sistema Tessera Sanitaria e per la
    // corretta emissione di fatture/ricevute sanitarie (esenti da fatturazione elettronica SDI
    // ai sensi del DM 19/10/2020 e succ. proroghe, art. 10-bis DL 119/2018). ---
    taxCode?: string | null;
    pec?: string | null;
    /** Codice destinatario SDI, usato SOLO per righe non sanitarie (es. vendita prodotti) fatturate elettronicamente. */
    sdiRecipientCode?: string | null;
    address?: string | null;
    city?: string | null;
    province?: string | null;
    zipCode?: string | null;
    /** Progressivo dell'ultimo numero fattura/ricevuta emesso per anno fiscale: { "2026": 42 }. */
    lastDocumentNumberByYear: Record<string, number>;
}

export type TenantCreationAttributes = Optional<
    TenantAttributes,
    'id' | 'isActive' | 'isPremium' | 'userQuantity' | 'structureQuantity' | 'MBQuantity' | 'lastDocumentNumberByYear'
>;

export class Tenant extends Model<TenantAttributes, TenantCreationAttributes> implements TenantAttributes {
    declare id: string;
    declare businessName: string | null;
    declare VATNumber: string | null;
    declare license: string;
    declare isActive: boolean;
    declare idStripe: string;
    declare isPremium: boolean;
    declare userQuantity: number;
    declare maxUserQuantity: number;
    declare structureQuantity: number;
    declare maxStructureQuantity: number;
    declare MBQuantity: number;
    declare taxCode: string | null;
    declare pec: string | null;
    declare sdiRecipientCode: string | null;
    declare address: string | null;
    declare city: string | null;
    declare province: string | null;
    declare zipCode: string | null;
    declare lastDocumentNumberByYear: Record<string, number>;
}

Tenant.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        businessName: { type: DataTypes.STRING, allowNull: true, unique: true },
        VATNumber: { type: DataTypes.STRING, allowNull: true, unique: true },
        license: { type: DataTypes.TEXT, allowNull: false },
        isActive: { type: DataTypes.BOOLEAN, defaultValue: false },
        idStripe: { type: DataTypes.STRING, allowNull: false },
        isPremium: { type: DataTypes.BOOLEAN, defaultValue: false },
        userQuantity: { type: DataTypes.INTEGER, defaultValue: 1 },
        maxUserQuantity: { type: DataTypes.INTEGER, allowNull: false },
        structureQuantity: { type: DataTypes.INTEGER, defaultValue: 1 },
        maxStructureQuantity: { type: DataTypes.INTEGER, allowNull: false },
        MBQuantity: { type: DataTypes.INTEGER, defaultValue: 100 },
        taxCode: { type: DataTypes.STRING(16), allowNull: true },
        pec: { type: DataTypes.STRING, allowNull: true },
        sdiRecipientCode: { type: DataTypes.STRING(7), allowNull: true },
        address: { type: DataTypes.STRING, allowNull: true },
        city: { type: DataTypes.STRING, allowNull: true },
        province: { type: DataTypes.STRING(2), allowNull: true },
        zipCode: { type: DataTypes.STRING(10), allowNull: true },
        lastDocumentNumberByYear: { type: DataTypes.JSONB, defaultValue: {} }
    },
    { sequelize, modelName: 'tenant', tableName: 'tenants' }
);

export default Tenant;


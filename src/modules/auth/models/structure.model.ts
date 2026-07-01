import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface StructureAttributes {
    id: string;
    name?: string | null;
    address?: string | null;
    tenantId: string;
    // --- Dati anagrafico/fiscali richiesti per Sistema Tessera Sanitaria (STS) e Fascicolo
    // Sanitario Elettronico (FSE): identificano univocamente il "luogo di erogazione" della
    // prestazione sanitaria, necessario nel tracciato STS e nei metadati IHE/CDA2 del FSE. ---
    city?: string | null;
    province?: string | null;
    zipCode?: string | null;
    /** Codice Regione ISTAT: individua l'infrastruttura di interoperabilità FSE regionale competente. */
    region?: string | null;
    /** Codice struttura sanitaria (es. codice STS2 se accreditata SSN, o codice interno). */
    structureCode?: string | null;
}

export type StructureCreationAttributes = Optional<StructureAttributes, 'id'>;

export class Structure extends Model<StructureAttributes, StructureCreationAttributes> implements StructureAttributes {
    declare id: string;
    declare name: string | null;
    declare address: string | null;
    declare tenantId: string;
    declare city: string | null;
    declare province: string | null;
    declare zipCode: string | null;
    declare region: string | null;
    declare structureCode: string | null;
}

Structure.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        name: { type: DataTypes.STRING, allowNull: true },
        address: { type: DataTypes.STRING, allowNull: true },
        tenantId: { type: DataTypes.UUID, allowNull: false },
        city: { type: DataTypes.STRING, allowNull: true },
        province: { type: DataTypes.STRING(2), allowNull: true },
        zipCode: { type: DataTypes.STRING(10), allowNull: true },
        region: { type: DataTypes.STRING, allowNull: true },
        structureCode: { type: DataTypes.STRING, allowNull: true }
    },
    { sequelize, modelName: 'structure', tableName: 'structures' }
);

export default Structure;


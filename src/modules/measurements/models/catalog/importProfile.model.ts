import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../../config/database.js';
import type { MappingRule, DerivationRule } from '../../mapping/types.js';
import type { ObservationSide } from '../observation.model.js';

/**
 * Definizione della mappatura di un formato file, salvata come DATO (non codice).
 * È esattamente ciò che il "mapping wizard" produce: colonne del file -> metriche del dizionario.
 */
export interface ImportProfileDefinition {
    patientColumn?: string;
    dateColumn: string;
    sideAliases?: Record<string, ObservationSide>;
    rules: MappingRule[];
    derivations?: DerivationRule[];
}

export type ImportProfileStatus = 'DRAFT' | 'PUBLISHED';

export interface ImportProfileAttributes {
    id: string;
    /** Device del catalogo a cui appartiene questa mappatura (DeviceSource.sourceId). */
    sourceId: string;
    name: string;
    /** Separatore del file (di default virgola). */
    delimiter: string;
    /** La mappatura vera e propria (colonne -> metriche), consumata dal motore. */
    definition: ImportProfileDefinition;
    status: ImportProfileStatus;
    /** Tenant che ha contribuito/creato la mappatura (tracciabilità), null per quelle di sistema. */
    contributedByTenantId?: string | null;
}

export type ImportProfileCreationAttributes = Optional<
    ImportProfileAttributes,
    'id' | 'delimiter' | 'status' | 'contributedByTenantId'
>;

/**
 * Catalogo delle mappature di import (schema public, condiviso da tutti i tenant).
 * È il cuore della scalabilità: quando un centro incontra un nuovo device, mappa il suo CSV UNA volta
 * (via wizard) e la mappatura, pubblicata qui, diventa disponibile a TUTTI i centri con lo stesso device.
 * Nessun codice, nessun deploy, nessun contatto col produttore.
 */
export class ImportProfile
    extends Model<ImportProfileAttributes, ImportProfileCreationAttributes>
    implements ImportProfileAttributes {
    declare id: string;
    declare sourceId: string;
    declare name: string;
    declare delimiter: string;
    declare definition: ImportProfileDefinition;
    declare status: ImportProfileStatus;
    declare contributedByTenantId: string | null;
}

ImportProfile.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        sourceId: { type: DataTypes.STRING, allowNull: false, unique: true },
        name: { type: DataTypes.STRING, allowNull: false },
        delimiter: { type: DataTypes.STRING, allowNull: false, defaultValue: ',' },
        definition: { type: DataTypes.JSONB, allowNull: false },
        status: {
            type: DataTypes.ENUM('DRAFT', 'PUBLISHED'),
            allowNull: false,
            defaultValue: 'DRAFT'
        },
        contributedByTenantId: { type: DataTypes.STRING, allowNull: true }
    },
    { sequelize, modelName: 'importProfile', tableName: 'import_profiles', schema: 'public' }
);

export default ImportProfile;


import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../../config/database.js';

export type MetricCategory =
    | 'STRENGTH'
    | 'ROM'
    | 'NEUROMUSCULAR'
    | 'MOVEMENT'
    | 'EMG'
    | 'QUESTIONNAIRE'
    | 'SYMPTOM'
    | 'VITAL';

export type MetricDataType = 'NUMBER' | 'RATIO' | 'ANGLE' | 'TIME' | 'BOOLEAN';

export interface MetricDefinitionAttributes {
    id: string;
    /** Codice univoco stabile, es. "KNEE_EXT_PEAK_FORCE". È la chiave logica referenziata dalle Observation. */
    code: string;
    displayName: string;
    clinicalDescription?: string | null;
    category: MetricCategory;
    /** Unità canonica in cui il dato viene SEMPRE salvato (N, Nm, cm, %, deg, ms, Hz…). */
    unit: string;
    dataType: MetricDataType;
    physiologicalMin?: number | null;
    physiologicalMax?: number | null;
    /** Minimal Clinically Important Difference. */
    mcid?: number | null;
    higherIsBetter: boolean;
    /** Distretti anatomici applicabili (string[]). */
    applicableDistricts?: string[] | null;
    /** Lati applicabili, es. ["LEFT","RIGHT","BILATERAL"]. */
    applicableSides?: string[] | null;
    isActive: boolean;
}

export type MetricDefinitionCreationAttributes = Optional<
    MetricDefinitionAttributes,
    'id' | 'dataType' | 'higherIsBetter' | 'isActive'
>;

/**
 * Clinical Data Dictionary: definizione UNICA di ogni variabile misurabile della piattaforma.
 * Vive nello schema `public` ed è condivisa da tutti i tenant (come i cataloghi scale/test/esercizi).
 * Integrare un dispositivo = dire "produce queste N MetricDefinition", senza creare nuove tabelle.
 */
export class MetricDefinition
    extends Model<MetricDefinitionAttributes, MetricDefinitionCreationAttributes>
    implements MetricDefinitionAttributes {
    declare id: string;
    declare code: string;
    declare displayName: string;
    declare clinicalDescription: string | null;
    declare category: MetricCategory;
    declare unit: string;
    declare dataType: MetricDataType;
    declare physiologicalMin: number | null;
    declare physiologicalMax: number | null;
    declare mcid: number | null;
    declare higherIsBetter: boolean;
    declare applicableDistricts: string[] | null;
    declare applicableSides: string[] | null;
    declare isActive: boolean;
}

MetricDefinition.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        code: { type: DataTypes.STRING, allowNull: false, unique: true },
        displayName: { type: DataTypes.STRING, allowNull: false },
        clinicalDescription: { type: DataTypes.TEXT, allowNull: true },
        category: {
            type: DataTypes.ENUM(
                'STRENGTH',
                'ROM',
                'NEUROMUSCULAR',
                'MOVEMENT',
                'EMG',
                'QUESTIONNAIRE',
                'SYMPTOM',
                'VITAL'
            ),
            allowNull: false
        },
        unit: { type: DataTypes.STRING, allowNull: false },
        dataType: {
            type: DataTypes.ENUM('NUMBER', 'RATIO', 'ANGLE', 'TIME', 'BOOLEAN'),
            allowNull: false,
            defaultValue: 'NUMBER'
        },
        physiologicalMin: { type: DataTypes.DOUBLE, allowNull: true },
        physiologicalMax: { type: DataTypes.DOUBLE, allowNull: true },
        mcid: { type: DataTypes.DOUBLE, allowNull: true },
        higherIsBetter: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        applicableDistricts: { type: DataTypes.JSON, allowNull: true },
        applicableSides: { type: DataTypes.JSON, allowNull: true },
        isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
    },
    { sequelize, modelName: 'metricDefinition', tableName: 'metric_definitions', schema: 'public' }
);

export default MetricDefinition;


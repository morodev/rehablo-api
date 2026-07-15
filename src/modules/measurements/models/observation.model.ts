import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export type ObservationSide = 'LEFT' | 'RIGHT' | 'BILATERAL';
export type ObservationAggregation = 'BEST' | 'MEAN' | 'RAW' | 'SINGLE';
export type ObservationQuality = 'GOOD' | 'DOUBTFUL' | 'INVALID';
/**
 * Provenienza del dato: da dove è entrato nel sistema.
 * - MANUAL: inserito a mano dall'operatore
 * - IMPORT: importato da file (CSV/Excel/PDF) di un dispositivo
 * - DEVICE_API: arrivato via API (Ingestion API inbound o connettore pull, es. VALD)
 * - DERIVED: calcolato da Rehablo a partire da altre Observation (es. LSI)
 */
export type ObservationProvenance = 'MANUAL' | 'IMPORT' | 'DEVICE_API' | 'DERIVED';

export interface ObservationAttributes {
    id: string;
    tenantId: string;
    patientId: string;
    evaluationId?: string | null;
    sessionId?: string | null;
    /** Riferimento logico a MetricDefinition.code (schema public). Non è una FK cross-schema. */
    metricCode: string;
    /** Valore numerico (per la maggior parte delle metriche). */
    value?: number | null;
    /** Valore complesso (es. curva forza-tempo) quando il singolo numero non basta. */
    valueJson?: Record<string, unknown> | null;
    unit: string;
    side: ObservationSide;
    trialNumber?: number | null;
    aggregation: ObservationAggregation;
    effectiveDateTime: Date;
    /** Sorgente/dispositivo, es. "kinvent-kforce". Null per l'inserimento manuale. */
    sourceId?: string | null;
    /** Utente che ha eseguito/registrato la misura. */
    operatorId?: string | null;
    /** Riferimento al file grezzo originale (object storage), quando presente. */
    rawFileId?: string | null;
    quality: ObservationQuality;
    calculationMethod?: string | null;
    provenance: ObservationProvenance;
    /** Metadata della misurazione: modello, versione software, protocollo, freq. campionamento, note… */
    metadata?: Record<string, unknown> | null;
}

export type ObservationCreationAttributes = Optional<
    ObservationAttributes,
    'id' | 'side' | 'aggregation' | 'quality'
>;

/**
 * Misurazione canonica (modellata su FHIR Observation). Tenant-scoped: ogni query passa da
 * `Observation.schema(req.tenantSchema)`. È il punto in cui confluiscono TUTTI i canali di
 * ingestione (manuale, import file, API, connettori) tramite l'unico servizio di ingestione.
 */
export class Observation
    extends Model<ObservationAttributes, ObservationCreationAttributes>
    implements ObservationAttributes {
    declare id: string;
    declare tenantId: string;
    declare patientId: string;
    declare evaluationId: string | null;
    declare sessionId: string | null;
    declare metricCode: string;
    declare value: number | null;
    declare valueJson: Record<string, unknown> | null;
    declare unit: string;
    declare side: ObservationSide;
    declare trialNumber: number | null;
    declare aggregation: ObservationAggregation;
    declare effectiveDateTime: Date;
    declare sourceId: string | null;
    declare operatorId: string | null;
    declare rawFileId: string | null;
    declare quality: ObservationQuality;
    declare calculationMethod: string | null;
    declare provenance: ObservationProvenance;
    declare metadata: Record<string, unknown> | null;
}

Observation.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        tenantId: { type: DataTypes.STRING, allowNull: false },
        patientId: { type: DataTypes.UUID, allowNull: false },
        evaluationId: { type: DataTypes.UUID, allowNull: true },
        sessionId: { type: DataTypes.UUID, allowNull: true },
        metricCode: { type: DataTypes.STRING, allowNull: false },
        value: { type: DataTypes.DOUBLE, allowNull: true },
        valueJson: { type: DataTypes.JSONB, allowNull: true },
        unit: { type: DataTypes.STRING, allowNull: false },
        side: {
            type: DataTypes.ENUM('LEFT', 'RIGHT', 'BILATERAL'),
            allowNull: false,
            defaultValue: 'BILATERAL'
        },
        trialNumber: { type: DataTypes.INTEGER, allowNull: true },
        aggregation: {
            type: DataTypes.ENUM('BEST', 'MEAN', 'RAW', 'SINGLE'),
            allowNull: false,
            defaultValue: 'SINGLE'
        },
        effectiveDateTime: { type: DataTypes.DATE, allowNull: false },
        sourceId: { type: DataTypes.STRING, allowNull: true },
        operatorId: { type: DataTypes.STRING, allowNull: true },
        rawFileId: { type: DataTypes.UUID, allowNull: true },
        quality: {
            type: DataTypes.ENUM('GOOD', 'DOUBTFUL', 'INVALID'),
            allowNull: false,
            defaultValue: 'GOOD'
        },
        calculationMethod: { type: DataTypes.STRING, allowNull: true },
        provenance: {
            type: DataTypes.ENUM('MANUAL', 'IMPORT', 'DEVICE_API', 'DERIVED'),
            allowNull: false
        },
        metadata: { type: DataTypes.JSONB, allowNull: true }
    },
    {
        sequelize,
        modelName: 'observation',
        tableName: 'observations',
        indexes: [
            { fields: ['patientId'] },
            { fields: ['metricCode'] },
            { fields: ['patientId', 'metricCode'] }
        ]
    }
);

export default Observation;


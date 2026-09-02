import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export const PATIENT_COLORS = [
    'blue',
    'emerald',
    'violet',
    'amber',
    'rose',
    'cyan',
    'indigo',
    'teal',
    'fuchsia',
    'orange'
] as const;

export type PatientColor = typeof PATIENT_COLORS[number];

export interface PatientAttributes {
    id: string;
    tenantId: string;
    /** Utente che ha creato l'anagrafica. È un dato di audit, non determina la visibilità. */
    userId: string;
    // --- Multi-struttura/multi-regione: un tenant può avere più Structure (sedi), anche in
    // Regioni diverse. `structureId` indica la struttura di riferimento anagrafico del
    // paziente (dove è stato preso in carico), usata come DEFAULT per instradare l'invio al
    // FSE regionale quando il singolo atto clinico (Evaluation) non specifica una struttura
    // propria. Non è una FK cross-schema (Structure vive nello schema "public"), stesso
    // pattern già usato per `tenantId`/`userId`. ---
    structureId: string | null;
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
    /** Colore opzionale scelto dall'utente per riconoscere il paziente nelle viste operative. */
    color?: PatientColor | null;
    background: string;
    notes?: string | null;
    /** Archiviazione logica: preserva cartella clinica, appuntamenti e documenti collegati. */
    archivedAt?: Date | null;
    // --- Adempimenti privacy/GDPR (art. 9 GDPR, dati sanitari) ---
    /** Consenso esplicito al trattamento dei dati sanitari (obbligatorio prima di qualunque prestazione). */
    privacyConsent: boolean;
    privacyConsentDate?: Date | null;
    /** Versione dell'informativa privacy accettata dal paziente, per tracciabilità in caso di aggiornamenti. */
    privacyPolicyVersion?: string | null;
    /** Documento firmato che prova il consenso; il path resta interno allo storage del tenant. */
    privacyDocumentStoragePath?: string | null;
    privacyDocumentOriginalName?: string | null;
    privacyDocumentMimeType?: string | null;
    privacyDocumentSizeBytes?: number | null;
    privacyDocumentUploadedAt?: Date | null;
    privacyDocumentUploadedBy?: string | null;
    // --- Sistema Tessera Sanitaria (D.Lgs. 175/2014): il paziente ha diritto di opporsi
    // all'invio dei propri dati di spesa sanitaria al Sistema TS per la dichiarazione precompilata.
    // Se true, la fattura/ricevuta NON deve essere inclusa nel file di trasmissione annuale/mensile. ---
    stsOppositionToDataSending: boolean;
    // --- Fascicolo Sanitario Elettronico (D.L. 179/2012 art. 12, DPCM 178/2015, D.L. 34/2020 art. 11) ---
    /** Consenso all'alimentazione del FSE regionale con i documenti prodotti da questo studio. */
    fseConsentFeeding?: boolean | null;
    /** Consenso alla consultazione del FSE da parte di altri operatori sanitari (facoltativo, revocabile). */
    fseConsentViewing?: boolean | null;
    fseConsentDate?: Date | null;
}

export type PatientCreationAttributes = Optional<
    PatientAttributes,
    'id' | 'isShared' | 'sharedWith' | 'emails' | 'tags' | 'phoneNumbers' | 'color' | 'background' | 'name' | 'archivedAt' | 'privacyConsent' | 'stsOppositionToDataSending'
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
    declare structureId: string | null;
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
    declare color: PatientColor | null;
    declare background: string;
    declare notes: string | null;
    declare archivedAt: Date | null;
    declare privacyConsent: boolean;
    declare privacyConsentDate: Date | null;
    declare privacyPolicyVersion: string | null;
    declare privacyDocumentStoragePath: string | null;
    declare privacyDocumentOriginalName: string | null;
    declare privacyDocumentMimeType: string | null;
    declare privacyDocumentSizeBytes: number | null;
    declare privacyDocumentUploadedAt: Date | null;
    declare privacyDocumentUploadedBy: string | null;
    declare stsOppositionToDataSending: boolean;
    declare fseConsentFeeding: boolean | null;
    declare fseConsentViewing: boolean | null;
    declare fseConsentDate: Date | null;
}

Patient.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        tenantId: { type: DataTypes.STRING, allowNull: false },
        userId: { type: DataTypes.STRING, allowNull: false },
        // `allowNull: false` vale per tutti i nuovi record. Gli schemi legacy vengono
        // prima riallineati dal backfill; il sync additive non forza il vincolo sui dati storici.
        structureId: { type: DataTypes.UUID, allowNull: false },
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
        color: {
            type: DataTypes.STRING,
            allowNull: true,
            defaultValue: null,
            validate: { isIn: [[...PATIENT_COLORS]] }
        },
        background: { type: DataTypes.STRING, defaultValue: 'assets/images/cards/17-640x480.jpg' },
        notes: DataTypes.TEXT,
        archivedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
        privacyConsent: { type: DataTypes.BOOLEAN, defaultValue: false },
        privacyConsentDate: DataTypes.DATE,
        privacyPolicyVersion: DataTypes.STRING,
        privacyDocumentStoragePath: DataTypes.STRING,
        privacyDocumentOriginalName: DataTypes.STRING,
        privacyDocumentMimeType: DataTypes.STRING,
        privacyDocumentSizeBytes: DataTypes.INTEGER,
        privacyDocumentUploadedAt: DataTypes.DATE,
        privacyDocumentUploadedBy: DataTypes.STRING,
        stsOppositionToDataSending: { type: DataTypes.BOOLEAN, defaultValue: false },
        fseConsentFeeding: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: null },
        fseConsentViewing: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: null },
        fseConsentDate: DataTypes.DATE
    },
    {
        sequelize,
        modelName: 'patient',
        tableName: 'patients',
        defaultScope: {
            attributes: { exclude: ['privacyDocumentStoragePath'] }
        },
        indexes: [
            { name: 'patients_structure_archived_idx', fields: ['structureId', 'archivedAt'] },
            { name: 'patients_fiscal_code_idx', fields: ['fiscalCode'] }
        ]
    }
);

export default Patient;


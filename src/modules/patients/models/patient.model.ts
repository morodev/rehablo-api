import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface PatientAttributes {
    id: string;
    tenantId: string;
    userId: string;
    // --- Multi-struttura/multi-regione: un tenant può avere più Structure (sedi), anche in
    // Regioni diverse. `structureId` indica la struttura di riferimento anagrafico del
    // paziente (dove è stato preso in carico), usata come DEFAULT per instradare l'invio al
    // FSE regionale quando il singolo atto clinico (Evaluation) non specifica una struttura
    // propria. Non è una FK cross-schema (Structure vive nello schema "public"), stesso
    // pattern già usato per `tenantId`/`userId`. ---
    structureId?: string | null;
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
    // --- Adempimenti privacy/GDPR (art. 9 GDPR, dati sanitari) ---
    /** Consenso esplicito al trattamento dei dati sanitari (obbligatorio prima di qualunque prestazione). */
    privacyConsent: boolean;
    privacyConsentDate?: Date | null;
    /** Versione dell'informativa privacy accettata dal paziente, per tracciabilità in caso di aggiornamenti. */
    privacyPolicyVersion?: string | null;
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
    'id' | 'isShared' | 'sharedWith' | 'emails' | 'tags' | 'phoneNumbers' | 'background' | 'name' | 'privacyConsent' | 'stsOppositionToDataSending'
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
    declare background: string;
    declare notes: string | null;
    declare privacyConsent: boolean;
    declare privacyConsentDate: Date | null;
    declare privacyPolicyVersion: string | null;
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
        structureId: { type: DataTypes.UUID, allowNull: true },
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
        notes: DataTypes.TEXT,
        privacyConsent: { type: DataTypes.BOOLEAN, defaultValue: false },
        privacyConsentDate: DataTypes.DATE,
        privacyPolicyVersion: DataTypes.STRING,
        stsOppositionToDataSending: { type: DataTypes.BOOLEAN, defaultValue: false },
        fseConsentFeeding: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: null },
        fseConsentViewing: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: null },
        fseConsentDate: DataTypes.DATE
    },
    { sequelize, modelName: 'patient', tableName: 'patients' }
);

export default Patient;


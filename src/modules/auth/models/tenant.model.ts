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
    email?: string | null;
    phone?: string | null;
    // --- Regime fiscale e opzioni di fatturazione (Italia). ---
    // Il regime determina se in fattura si espone l'IVA, quale natura indicare al suo posto, se è
    // ammessa la ritenuta d'acconto e quali diciture sono obbligatorie sul documento: senza questo
    // dato il software può solo indovinare. Vedi docs/REGIME_FISCALE_IT.md e
    // src/modules/invoice/utils/fiscalRegime.ts.
    /** Codice tabella `RegimeFiscale` FatturaPA (RF01-RF19). Default: RF01 ordinario. */
    taxRegime?: string | null;
    /** Cassa previdenziale: 'NONE' | 'INPS_GS' (rivalsa 4%) | 'CASSA' (contributo integrativo). */
    socialSecurityFund?: string | null;
    /** Aliquota del contributo previdenziale proposta in fattura (es. 4 per la Gestione Separata). */
    socialSecurityRate?: number | null;
    /** Aliquota ritenuta d'acconto proposta in fattura (art. 25 DPR 600/73: 20%). */
    withholdingRate?: number | null;
    /** Importo dell'imposta di bollo (DPR 642/72: 2,00 €, storicamente variato). */
    stampDutyAmount?: number | null;
    /** Se il bollo va riaddebitato al paziente e quindi sommato al totale (art. 15 DPR 633/72). */
    stampChargedToPatient?: boolean | null;
    /** Progressivo dell'ultimo numero fattura/ricevuta emesso per anno fiscale: { "2026": 42 }. */
    lastDocumentNumberByYear: Record<string, number>;
}

export type TenantCreationAttributes = Optional<
    TenantAttributes,
    | 'id'
    | 'isActive'
    | 'isPremium'
    | 'userQuantity'
    | 'structureQuantity'
    | 'MBQuantity'
    | 'lastDocumentNumberByYear'
    | 'taxRegime'
    | 'socialSecurityFund'
    | 'socialSecurityRate'
    | 'withholdingRate'
    | 'stampDutyAmount'
    | 'stampChargedToPatient'
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
    declare email: string | null;
    declare phone: string | null;
    declare taxRegime: string | null;
    declare socialSecurityFund: string | null;
    declare socialSecurityRate: number | null;
    declare withholdingRate: number | null;
    declare stampDutyAmount: number | null;
    declare stampChargedToPatient: boolean | null;
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
        email: { type: DataTypes.STRING, allowNull: true },
        phone: { type: DataTypes.STRING, allowNull: true },
        // Il default RF01 (ordinario) è la scelta prudente: applica l'IVA di riga e ammette la
        // ritenuta, quindi non "nasconde" imposte a chi non ha ancora configurato il regime.
        taxRegime: { type: DataTypes.STRING(4), allowNull: true, defaultValue: 'RF01' },
        socialSecurityFund: { type: DataTypes.STRING(16), allowNull: true, defaultValue: 'NONE' },
        socialSecurityRate: { type: DataTypes.DECIMAL(5, 2), allowNull: true, defaultValue: 4 },
        withholdingRate: { type: DataTypes.DECIMAL(5, 2), allowNull: true, defaultValue: 20 },
        stampDutyAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: true, defaultValue: 2 },
        stampChargedToPatient: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: true },
        lastDocumentNumberByYear: { type: DataTypes.JSONB, defaultValue: {} }
    },
    { sequelize, modelName: 'tenant', tableName: 'tenants' }
);

export default Tenant;


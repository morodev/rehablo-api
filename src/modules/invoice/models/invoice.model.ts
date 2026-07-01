import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface InvoiceAttributes {
    id: string;
    emissionDate?: Date | null;
    invoiceNet?: number | null;
    invoiceTotal?: number | null;
    sellingPrice?: number | null;
    discSellingPrice?: number | null;
    invoiceVAT?: number | null;
    patientID?: string | null;
    isCashPro: boolean;
    cashPro?: string | null;
    isRivals: boolean;
    rivals?: number | null;
    isTaxWithholding: boolean;
    taxWithholding?: number | null;
    isStamp: boolean;
    stampAmount?: number | null;
    paymentMethod?: string | null;
    discountType?: string | null;
    discountAmount?: number | null;
    status?: string | null;
    paymentTerms?: Date | null;
    // --- Adempimenti fiscali per prestazioni sanitarie (fisioterapista libero professionista) ---
    /** Numero progressivo del documento nell'anno fiscale (obbligatorio, non deve avere "buchi"). */
    documentNumber?: number | null;
    /** Anno fiscale di riferimento della numerazione progressiva. */
    documentYear?: number | null;
    /** 'fattura' | 'ricevuta_fiscale' | 'nota_di_credito'. */
    documentType: string;
    /** Natura IVA (es. "N4" = operazioni esenti art.10 DPR 633/72, tipico delle prestazioni sanitarie).
     *  Le prestazioni sanitarie sono ESENTI da fattura elettronica via SDI (DM 19/10/2020): il documento
     *  va emesso "fuori SDI" (cartaceo/PDF) e i relativi dati trasmessi al Sistema Tessera Sanitaria. */
    vatNature?: string | null;
    // --- Sistema Tessera Sanitaria (D.Lgs. 175/2014, D.M. 31/07/2015 e succ. specifiche tecniche) ---
    /** Codice "tipologia di spesa" della tabella ministeriale Sistema TS (va verificato/aggiornato annualmente). */
    stsExpenseTypeCode?: string | null;
    /** true se il documento NON deve essere incluso nell'invio Sistema TS (opposizione paziente o non sanitario). */
    stsExcluded: boolean;
    stsSent: boolean;
    stsSentAt?: Date | null;
}

export type InvoiceCreationAttributes = Optional<
    InvoiceAttributes,
    'id' | 'isCashPro' | 'isRivals' | 'isTaxWithholding' | 'isStamp' | 'documentType' | 'stsExcluded' | 'stsSent'
>;

/**
 * Unified invoice model: merges the richer fiscal fields from the former "rehablo-invoice" (v2)
 * service (INPS rivalsa, ritenuta d'acconto, marca da bollo, discounts) with the relational
 * approach (real Product/Service associations via InvoiceProducts/InvoiceServices) of the former
 * "rehablo-invoice-service" (v1).
 *
 * Tenant-scoped model: always access through `Invoice.schema(req.tenantSchema)`.
 */
export class Invoice extends Model<InvoiceAttributes, InvoiceCreationAttributes> implements InvoiceAttributes {
    declare id: string;
    declare emissionDate: Date | null;
    declare invoiceNet: number | null;
    declare invoiceTotal: number | null;
    declare sellingPrice: number | null;
    declare discSellingPrice: number | null;
    declare invoiceVAT: number | null;
    declare patientID: string | null;
    declare isCashPro: boolean;
    declare cashPro: string | null;
    declare isRivals: boolean;
    declare rivals: number | null;
    declare isTaxWithholding: boolean;
    declare taxWithholding: number | null;
    declare isStamp: boolean;
    declare stampAmount: number | null;
    declare paymentMethod: string | null;
    declare discountType: string | null;
    declare discountAmount: number | null;
    declare status: string | null;
    declare paymentTerms: Date | null;
    declare documentNumber: number | null;
    declare documentYear: number | null;
    declare documentType: string;
    declare vatNature: string | null;
    declare stsExpenseTypeCode: string | null;
    declare stsExcluded: boolean;
    declare stsSent: boolean;
    declare stsSentAt: Date | null;
}

Invoice.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        emissionDate: DataTypes.DATEONLY,
        invoiceNet: DataTypes.DECIMAL(10, 2),
        invoiceTotal: DataTypes.DECIMAL(10, 2),
        sellingPrice: DataTypes.DECIMAL(10, 2),
        discSellingPrice: DataTypes.DECIMAL(10, 2),
        invoiceVAT: DataTypes.DECIMAL(10, 2),
        patientID: DataTypes.UUID,
        isCashPro: { type: DataTypes.BOOLEAN, defaultValue: false },
        cashPro: DataTypes.STRING,
        isRivals: { type: DataTypes.BOOLEAN, defaultValue: false },
        rivals: DataTypes.INTEGER,
        isTaxWithholding: { type: DataTypes.BOOLEAN, defaultValue: false },
        taxWithholding: DataTypes.INTEGER,
        isStamp: { type: DataTypes.BOOLEAN, defaultValue: false },
        stampAmount: DataTypes.DECIMAL(10, 2),
        paymentMethod: DataTypes.STRING,
        discountType: DataTypes.STRING,
        discountAmount: DataTypes.DECIMAL(10, 2),
        status: DataTypes.STRING,
        paymentTerms: DataTypes.DATEONLY,
        documentNumber: DataTypes.INTEGER,
        documentYear: DataTypes.INTEGER,
        documentType: { type: DataTypes.STRING, defaultValue: 'fattura' },
        vatNature: DataTypes.STRING,
        stsExpenseTypeCode: DataTypes.STRING,
        stsExcluded: { type: DataTypes.BOOLEAN, defaultValue: false },
        stsSent: { type: DataTypes.BOOLEAN, defaultValue: false },
        stsSentAt: DataTypes.DATE
    },
    { sequelize, modelName: 'invoice', tableName: 'invoices' }
);

export default Invoice;


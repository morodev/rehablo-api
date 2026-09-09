import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export type InvoiceShareChannel = 'link' | 'email' | 'whatsapp';

export interface InvoiceShareLinkAttributes {
    id: string;
    tenantId: string;
    invoiceId: string;
    patientId: string | null;
    tokenHash: string;
    createdByUserId: string;
    channel: InvoiceShareChannel;
    expiresAt: Date;
    revokedAt?: Date | null;
    lastViewedAt?: Date | null;
    viewCount: number;
}

export type InvoiceShareLinkCreationAttributes = Optional<
    InvoiceShareLinkAttributes,
    'id' | 'patientId' | 'revokedAt' | 'lastViewedAt' | 'viewCount'
>;

/**
 * Link con cui la fattura viene consegnata al paziente (email o WhatsApp).
 *
 * Vive nello schema `public`, non in quello del tenant: la richiesta che apre il link è anonima e
 * non ha un utente da cui derivare lo schema, quindi il token deve essere risolvibile prima di
 * sapere a quale centro appartiene la fattura. È il record stesso a portare il `tenantId`.
 *
 * Del token si conserva solo l'hash SHA-256, come per gli inviti al portale: un dump del database
 * non consente di aprire le fatture.
 */
export class InvoiceShareLink
    extends Model<InvoiceShareLinkAttributes, InvoiceShareLinkCreationAttributes>
    implements InvoiceShareLinkAttributes {
    declare id: string;
    declare tenantId: string;
    declare invoiceId: string;
    declare patientId: string | null;
    declare tokenHash: string;
    declare createdByUserId: string;
    declare channel: InvoiceShareChannel;
    declare expiresAt: Date;
    declare revokedAt: Date | null;
    declare lastViewedAt: Date | null;
    declare viewCount: number;
}

InvoiceShareLink.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenantId: { type: DataTypes.UUID, allowNull: false },
        invoiceId: { type: DataTypes.UUID, allowNull: false },
        patientId: { type: DataTypes.UUID, allowNull: true },
        tokenHash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
        createdByUserId: { type: DataTypes.UUID, allowNull: false },
        channel: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'link' },
        expiresAt: { type: DataTypes.DATE, allowNull: false },
        revokedAt: { type: DataTypes.DATE, allowNull: true },
        lastViewedAt: { type: DataTypes.DATE, allowNull: true },
        viewCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
    },
    {
        sequelize,
        modelName: 'invoiceShareLink',
        tableName: 'invoice_share_links',
        indexes: [
            { fields: ['tenantId', 'invoiceId'] },
            { fields: ['expiresAt'] }
        ]
    }
);

/**
 * Sincronizza i modelli fattura che stanno in `public`. Non passa da `syncAuthModels` per non
 * legare il modulo auth a quello di fatturazione.
 */
export async function syncInvoicePublicModels(): Promise<void> {
    await InvoiceShareLink.sync({ alter: true });
}

export default InvoiceShareLink;

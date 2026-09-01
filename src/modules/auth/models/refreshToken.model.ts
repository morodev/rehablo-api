import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

/**
 * Refresh token opaco, persistito nello schema `public`.
 *
 * Scelte di sicurezza (vedi docs/RBAC_DESIGN.md §5):
 * - si salva solo l'HASH SHA-256: un dump del DB non permette di impersonare nessuno;
 * - ROTATION: ogni utilizzo invalida il token e ne emette uno nuovo;
 * - REUSE DETECTION: se arriva un token già ruotato significa che è stato copiato,
 *   quindi si revoca l'intera "famiglia" (tutta la catena nata dallo stesso login).
 */
export interface RefreshTokenAttributes {
    id: string;
    userId: string;
    /** SHA-256 esadecimale del token consegnato al client. Mai il valore in chiaro. */
    tokenHash: string;
    /** Identifica la catena di rotazioni nata da un singolo login. */
    familyId: string;
    expiresAt: Date;
    /** Valorizzato quando il token viene ruotato, revocato o invalidato per riuso. */
    revokedAt?: Date | null;
    /** Motivo della revoca: utile in fase di analisi di un incidente. */
    revokedReason?: string | null;
    /** Tenant e struttura attivi al momento dell'emissione: servono a riemettere l'access token. */
    tenantId?: string | null;
    structureId?: string | null;
    actor: 'staff' | 'patient';
    patientAccessId?: string | null;
    userAgent?: string | null;
    ipAddress?: string | null;
}

export type RefreshTokenCreationAttributes = Optional<
    RefreshTokenAttributes,
    'id' | 'revokedAt' | 'revokedReason' | 'tenantId' | 'structureId' | 'actor' | 'patientAccessId' | 'userAgent' | 'ipAddress'
>;

export class RefreshToken
    extends Model<RefreshTokenAttributes, RefreshTokenCreationAttributes>
    implements RefreshTokenAttributes {
    declare id: string;
    declare userId: string;
    declare tokenHash: string;
    declare familyId: string;
    declare expiresAt: Date;
    declare revokedAt: Date | null;
    declare revokedReason: string | null;
    declare tenantId: string | null;
    declare structureId: string | null;
    declare actor: 'staff' | 'patient';
    declare patientAccessId: string | null;
    declare userAgent: string | null;
    declare ipAddress: string | null;
}

RefreshToken.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        userId: { type: DataTypes.UUID, allowNull: false },
        tokenHash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
        familyId: { type: DataTypes.UUID, allowNull: false },
        expiresAt: { type: DataTypes.DATE, allowNull: false },
        revokedAt: { type: DataTypes.DATE, allowNull: true },
        revokedReason: { type: DataTypes.STRING, allowNull: true },
        tenantId: { type: DataTypes.UUID, allowNull: true },
        structureId: { type: DataTypes.UUID, allowNull: true },
        actor: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'staff' },
        patientAccessId: { type: DataTypes.UUID, allowNull: true },
        userAgent: { type: DataTypes.STRING, allowNull: true },
        ipAddress: { type: DataTypes.STRING, allowNull: true }
    },
    {
        sequelize,
        modelName: 'refreshToken',
        tableName: 'refresh_tokens',
        indexes: [{ fields: ['userId'] }, { fields: ['familyId'] }, { fields: ['expiresAt'] }]
    }
);

export default RefreshToken;


import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface UserAttributes {
    id: string;
    name?: string | null;
    surname?: string | null;
    email: string;
    password: string;
    calendarVisible: boolean;
    /** `true` una volta verificato l'indirizzo email. NON indica la sospensione dell'account. */
    isActive: boolean;
    calendarColor: string;
    isSuperAdmin: boolean;
    /**
     * Titolare dello studio: è l'utente nato dalla registrazione, quello che ha creato il tenant.
     * Ne esiste esattamente uno per tenant, non è eliminabile e il suo ruolo resta `OWNER`.
     */
    isTenant: boolean;
    isPremium: boolean;
    /**
     * Sospensione dell'account: valorizzata quando un amministratore disattiva l'utente.
     * È volutamente distinta da `isActive` (che indica la verifica dell'email), così la UI
     * può differenziare "in attesa di verifica" da "disattivato" e la riattivazione non
     * richiede un nuovo giro di verifica dell'indirizzo.
     */
    deactivatedAt?: Date | null;
    // --- Dati identificativi del professionista sanitario, richiesti per il tracciato Sistema
    // Tessera Sanitaria (identificazione dell'erogatore) e per i metadati FSE/CDA2 (autore del
    // documento clinico). Il fisioterapista è "professione sanitaria riabilitativa" ex L. 3/2018,
    // iscritta all'Albo unico TSRM-PSTRP. ---
    taxCode?: string | null;
    professionalRegisterNumber?: string | null;
    professionalRegisterProvince?: string | null;
}

export type UserCreationAttributes = Optional<
    UserAttributes,
    | 'id'
    | 'calendarVisible'
    | 'calendarColor'
    | 'isActive'
    | 'isSuperAdmin'
    | 'isTenant'
    | 'isPremium'
    | 'deactivatedAt'
>;

export class User extends Model<UserAttributes, UserCreationAttributes> implements UserAttributes {
    declare id: string;
    declare name: string | null;
    declare surname: string | null;
    declare email: string;
    declare password: string;
    declare calendarVisible: boolean;
    declare calendarColor: string;
    declare isActive: boolean;
    declare isSuperAdmin: boolean;
    declare isTenant: boolean;
    declare isPremium: boolean;
    declare deactivatedAt: Date | null;
    declare taxCode: string | null;
    declare professionalRegisterNumber: string | null;
    declare professionalRegisterProvince: string | null;
}

User.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        name: { type: DataTypes.STRING, allowNull: true },
        surname: { type: DataTypes.STRING, allowNull: true },
        email: { type: DataTypes.STRING, allowNull: false, unique: true },
        password: { type: DataTypes.STRING, allowNull: false },
        calendarVisible: { type: DataTypes.BOOLEAN, defaultValue: true },
        calendarColor: { type: DataTypes.STRING, allowNull: false, defaultValue: 'bg-primary' },
        isActive: { type: DataTypes.BOOLEAN, defaultValue: false },
        isSuperAdmin: { type: DataTypes.BOOLEAN, defaultValue: false },
        isTenant: { type: DataTypes.BOOLEAN, defaultValue: false },
        isPremium: { type: DataTypes.BOOLEAN, defaultValue: false },
        deactivatedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
        taxCode: { type: DataTypes.STRING(16), allowNull: true },
        professionalRegisterNumber: { type: DataTypes.STRING, allowNull: true },
        professionalRegisterProvince: { type: DataTypes.STRING(2), allowNull: true }
    },
    {
        sequelize,
        modelName: 'user',
        tableName: 'users',
        defaultScope: {
            attributes: { exclude: [] }
        },
        scopes: {
            withoutPassword: { attributes: { exclude: ['password'] } }
        }
    }
);

export default User;


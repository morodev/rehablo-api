import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export type CategoryAppliesTo = 'PRODUCT' | 'SERVICE' | 'BOTH';

export interface CategoryAttributes {
    id: string;
    name: string;
    /** A quale catalogo si applica questa categoria: solo prodotti, solo servizi, o entrambi. */
    appliesTo: CategoryAppliesTo;
    /** Colore per l'etichetta in UI (es. "#3B82F6"), puramente estetico. */
    color?: string | null;
    description?: string | null;
    /** Soft-delete: coerente con `Product.isActive`/`Service.isActive`. */
    isActive: boolean;
}

export type CategoryCreationAttributes = Optional<CategoryAttributes, 'id' | 'appliesTo' | 'isActive'>;

/** Tenant-scoped model: always access through `Category.schema(req.tenantSchema)`. */
export class Category extends Model<CategoryAttributes, CategoryCreationAttributes> implements CategoryAttributes {
    declare id: string;
    declare name: string;
    declare appliesTo: CategoryAppliesTo;
    declare color: string | null;
    declare description: string | null;
    declare isActive: boolean;
}

Category.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        name: { type: DataTypes.STRING, allowNull: false },
        appliesTo: { type: DataTypes.ENUM('PRODUCT', 'SERVICE', 'BOTH'), defaultValue: 'BOTH' },
        color: DataTypes.STRING,
        description: DataTypes.STRING,
        isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
    },
    { sequelize, modelName: 'category', tableName: 'categories' }
);

export default Category;


import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface ProductStructureAttributes {
    productId: string;
    structureId: string;
}

export class ProductStructure extends Model<ProductStructureAttributes> implements ProductStructureAttributes {
    declare productId: string;
    declare structureId: string;
}

ProductStructure.init(
    {
        productId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
        structureId: { type: DataTypes.UUID, allowNull: false, primaryKey: true }
    },
    {
        sequelize,
        modelName: 'productStructure',
        tableName: 'product_structures',
        indexes: [{name: 'product_structures_structure_id', fields: ['structureId']}]
    }
);

export default ProductStructure;

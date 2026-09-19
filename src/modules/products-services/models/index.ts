import Category from './category.model.js';
import Product from './product.model.js';
import ProductStructure from './productStructure.model.js';
import Service from './service.model.js';
import ServiceStructure from './serviceStructure.model.js';

export function registerProductsServicesAssociations(): void {
    Category.hasMany(Product, {foreignKey: 'categoryId'});
    Product.belongsTo(Category, {foreignKey: 'categoryId'});
    Category.hasMany(Service, {foreignKey: 'categoryId'});
    Service.belongsTo(Category, {foreignKey: 'categoryId'});

    Product.hasMany(ProductStructure, {foreignKey: 'productId', as: 'structureAvailabilities', onDelete: 'CASCADE'});
    ProductStructure.belongsTo(Product, {foreignKey: 'productId'});
    Service.hasMany(ServiceStructure, {foreignKey: 'serviceId', as: 'structureAvailabilities', onDelete: 'CASCADE'});
    ServiceStructure.belongsTo(Service, {foreignKey: 'serviceId'});
}

export {Category, Product, ProductStructure, Service, ServiceStructure};

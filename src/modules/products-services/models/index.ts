import Category from './category.model.js';
import Product from './product.model.js';
import Service from './service.model.js';

/**
 * Centralised associations for the "products-services" tenant-scoped models.
 * A `Category` classifies `Product`/`Service` items (es. "Sedute fisioterapiche", "Tutori e
 * ortesi", "Materiali di consumo"): utile per filtrare/raggruppare il catalogo e per reportistica
 * (es. fatturato per categoria), SENZA alcun impatto sul calcolo fiscale della fattura (quello
 * dipende solo da `sellingPrice`/`productVat` sulla singola riga, vedi `evalTotals.ts`).
 *
 * Registrata una sola volta a boot (stesso pattern di `registerEvaluationAssociations` ecc.):
 * funziona correttamente anche con le query `.schema(tenantSchema)` nei controller.
 */
export function registerProductsServicesAssociations(): void {
    Category.hasMany(Product, { foreignKey: 'categoryId' });
    Product.belongsTo(Category, { foreignKey: 'categoryId' });

    Category.hasMany(Service, { foreignKey: 'categoryId' });
    Service.belongsTo(Category, { foreignKey: 'categoryId' });
}

export { Category, Product, Service };


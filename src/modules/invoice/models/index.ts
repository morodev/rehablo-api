import Invoice from './invoice.model.js';
import InvoiceProduct from './invoiceProduct.model.js';
import InvoiceService from './invoiceService.model.js';

/**
 * Centralised associations for the "invoice" tenant-scoped models (dynamic "rehablo_<tenantId>" schema).
 *
 * Registrata una sola volta a boot (stesso pattern di `registerEvaluationAssociations`,
 * `registerProductsServicesAssociations`, ecc.): funziona correttamente anche con le query
 * `.schema(tenantSchema)` nei controller. Dichiarare l'associazione DENTRO al controller (una volta
 * per ogni richiesta HTTP, come faceva il vecchio `getScopedModels`) causa l'errore Sequelize
 * "You have used the alias X in two separate associations. Aliased associations must have unique
 * aliases." dalla seconda richiesta in poi: `Model.schema()` crea una sottoclasse "clone" che NON ha
 * una propria mappa `associations` propria, quindi eredita (per catena di prototipi) quella
 * dell'oggetto base, condivisa da TUTTI i clone/tenant/richieste nello stesso processo Node.
 *
 * `hasMany` invece di `belongsToMany` verso il catalogo Product/Service: il frontend (vedi
 * rehab.io_fe/invoices.types.ts: `InvoiceProductLine`/`InvoiceServiceLine`) si aspetta che
 * `invoice.products`/`invoice.services` siano DIRETTAMENTE le righe snapshot della tabella ponte
 * (`ProductId`/`ServiceId`, `productName`/`serviceName`, `productPrice`/`servicePrice`,
 * `productVat`/`serviceVat`, `quantity`, ecc.), non le entità di catalogo.
 */
export function registerInvoiceAssociations(): void {
    Invoice.hasMany(InvoiceProduct, { as: 'products', foreignKey: 'InvoiceId' });
    InvoiceProduct.belongsTo(Invoice, { foreignKey: 'InvoiceId' });

    Invoice.hasMany(InvoiceService, { as: 'services', foreignKey: 'InvoiceId' });
    InvoiceService.belongsTo(Invoice, { foreignKey: 'InvoiceId' });
}

export { Invoice, InvoiceProduct, InvoiceService };


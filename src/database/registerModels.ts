import {registerAuthAssociations} from '../modules/auth/models/index.js';
import {registerCatalogAssociations} from '../modules/human-body/models/catalog/index.js';
import {registerProtocolCatalogAssociations} from '../modules/protocols/models/catalog/index.js';
import '../modules/measurements/models/catalog/index.js';
import '../modules/billing/models/billing.model.js';
import '../modules/invoice/models/invoiceShareLink.model.js';
import '../modules/administration/models/quoteDelivery.model.js';
import {registerTenantModels} from '../tenantModelsRegistry.js';

let registered = false;

/** Model definitions and associations only. This function never opens a connection or runs DDL. */
export function registerDatabaseModels(): void {
    if (registered) return;
    registered = true;
    registerAuthAssociations();
    registerCatalogAssociations();
    registerProtocolCatalogAssociations();
    registerTenantModels();
}

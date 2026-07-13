import Dashboard from './dashboard.model.js';
import Widget from './widget.model.js';

/**
 * Centralised associations for the "configuration" (dashboard/widget) tenant-scoped models.
 *
 * Registrata una sola volta a boot (stesso pattern di `registerEvaluationAssociations`,
 * `registerInvoiceAssociations`, ecc.): funziona correttamente anche con le query
 * `.schema(tenantSchema)` nei controller. Dichiararla dentro il controller (una volta per ogni
 * richiesta HTTP, come faceva il vecchio `getScopedModels`) causa l'errore Sequelize "You have
 * used the alias X in two separate associations..." dalla seconda richiesta in poi, perché
 * `Model.schema()` crea un clone che eredita (senza copiarla) la stessa mappa `associations` del
 * modello base, condivisa da tutte le richieste/tenant nel processo.
 */
export function registerConfigurationAssociations(): void {
    Dashboard.hasMany(Widget, { onDelete: 'cascade', foreignKey: { allowNull: false }, hooks: true });
    Widget.belongsTo(Dashboard, { onDelete: 'cascade', foreignKey: { allowNull: false }, hooks: true });
}

export { Dashboard, Widget };


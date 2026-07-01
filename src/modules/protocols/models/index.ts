import ProtocolInstance from './protocolInstance.model.js';
import ProtocolPhaseInstance from './protocolPhaseInstance.model.js';
import ProtocolExerciseLog from './protocolExerciseLog.model.js';
import { ProtocolTemplate, ProtocolPhaseTemplate, ProtocolTemplateExercise } from './catalog/index.js';

/**
 * Centralised associations for the protocols tenant-scoped models (dynamic "rehablo_<tenantId>" schema).
 * Mirrors the human-body module pattern: tenant-scoped instances reference the public-schema catalog
 * via `constraints: false` (cross-schema foreign keys aren't enforceable by Postgres).
 */
export function registerProtocolAssociations(): void {
    ProtocolInstance.hasMany(ProtocolPhaseInstance, {
        foreignKey: 'protocolInstanceId',
        onDelete: 'cascade',
        hooks: true
    });
    ProtocolPhaseInstance.belongsTo(ProtocolInstance, { foreignKey: 'protocolInstanceId' });

    ProtocolPhaseInstance.hasMany(ProtocolExerciseLog, {
        foreignKey: 'protocolPhaseInstanceId',
        onDelete: 'cascade',
        hooks: true
    });
    ProtocolExerciseLog.belongsTo(ProtocolPhaseInstance, { foreignKey: 'protocolPhaseInstanceId' });

    // Cross-schema associations: tenant-scoped instances reference the public-schema catalog.
    ProtocolInstance.belongsTo(ProtocolTemplate, { foreignKey: 'protocolTemplateId', constraints: false });
    ProtocolPhaseInstance.belongsTo(ProtocolPhaseTemplate, {
        foreignKey: 'protocolPhaseTemplateId',
        constraints: false
    });
    ProtocolExerciseLog.belongsTo(ProtocolTemplateExercise, {
        foreignKey: 'protocolTemplateExerciseId',
        constraints: false
    });
}

export { ProtocolInstance, ProtocolPhaseInstance, ProtocolExerciseLog };


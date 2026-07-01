import Exercise from './exercise.model.js';
import ProtocolTemplate from './protocolTemplate.model.js';
import ProtocolPhaseTemplate from './protocolPhaseTemplate.model.js';
import ProtocolTemplateExercise from './protocolTemplateExercise.model.js';

/** Centralised associations for the protocols catalog (public schema, shared by every tenant). */
export function registerProtocolCatalogAssociations(): void {
    ProtocolTemplate.hasMany(ProtocolPhaseTemplate, {
        foreignKey: 'protocolTemplateId',
        onDelete: 'cascade',
        hooks: true
    });
    ProtocolPhaseTemplate.belongsTo(ProtocolTemplate, { foreignKey: 'protocolTemplateId' });

    ProtocolPhaseTemplate.hasMany(ProtocolTemplateExercise, {
        foreignKey: 'protocolPhaseTemplateId',
        onDelete: 'cascade',
        hooks: true
    });
    ProtocolTemplateExercise.belongsTo(ProtocolPhaseTemplate, { foreignKey: 'protocolPhaseTemplateId' });

    Exercise.hasMany(ProtocolTemplateExercise, { foreignKey: 'exerciseId' });
    ProtocolTemplateExercise.belongsTo(Exercise, { foreignKey: 'exerciseId' });
}

export async function syncProtocolCatalogModels(): Promise<void> {
    await Exercise.sync({ alter: true });
    await ProtocolTemplate.sync({ alter: true });
    await ProtocolPhaseTemplate.sync({ alter: true });
    await ProtocolTemplateExercise.sync({ alter: true });
}

export { Exercise, ProtocolTemplate, ProtocolPhaseTemplate, ProtocolTemplateExercise };


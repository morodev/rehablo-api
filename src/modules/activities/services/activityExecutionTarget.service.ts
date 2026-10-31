import type {Transaction} from 'sequelize';
import type {ActivityContext} from '../activities.types.js';
import {Activity, ActivityBoard, ActivityExecution} from '../models/index.js';
import {ActivityError} from '../utils/activityErrors.js';
import {parseActivityId} from '../utils/activityValidation.js';
import {sealActivityExecution, synchronizeActivityRecurrence} from './activityRecurrence.service.js';

/** Execution-local ORM adapter: its stable public id is the routine's id. Updates only
 * reach the execution model; the current card is projected explicitly after the command. */
export function executionActivity(context: ActivityContext): Activity {
    const parent = context.parentActivity!, execution = context.execution!;
    let adapter: Activity;
    const plain = () => ({...execution.get({plain: true}), id: parent.id,
        recurrence: parent.recurrence, currentExecutionId: execution.id,
        executionDate: execution.occurrenceDate, executionClosedAt: execution.closedAt,
        archivedAt: parent.archivedAt ?? execution.archivedAt, lateUpdatedAt: execution.lateUpdatedAt});
    adapter = new Proxy(execution, {
        get(target, property) {
            if (property === 'id') return parent.id;
            if (property === 'currentExecutionId') return execution.id;
            if (property === 'recurrence') return parent.recurrence;
            if (property === 'archivedAt') return parent.archivedAt ?? execution.archivedAt;
            if (property === 'get') return (key?: string | object) => typeof key === 'string'
                ? (plain() as Record<string, unknown>)[key] : plain();
            if (property === 'update') return async (values: Record<string, unknown>, options: object) => {
                await execution.update({...values, ...(execution.closedAt ? {
                    lateUpdatedAt: new Date(), lateUpdatedByUserId: context.userId
                } : {})}, options);
                return adapter;
            };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        }
    }) as unknown as Activity;
    return adapter;
}

export function executionChildren(context: ActivityContext): {executionId: string | null} {
    return {executionId: context.executionId ?? null};
}

export function targetsPastExecution(context: ActivityContext): boolean {
    return !!context.execution && !!context.parentActivity
        && context.execution.id !== context.parentActivity.currentExecutionId;
}

export async function prepareExecutionContext(
    context: ActivityContext, board: ActivityBoard, activityId: string, transaction: Transaction,
    options: {executionId?: unknown; expectedExecutionId?: unknown; write?: boolean; management?: boolean; replay?: boolean} = {}
): Promise<Activity> {
    const parent = await Activity.schema(context.schema).findOne({where: {id: activityId, boardId: board.id}, transaction});
    if (!parent) throw new ActivityError('ACTIVITY_NOT_FOUND', 404, 'Questa attività non è disponibile nella sede selezionata.');
    if (!parent.recurrence) {
        if (options.executionId || options.expectedExecutionId) throw new ActivityError('ACTIVITY_EXECUTION_CHANGED', 409,
            'Questa attività non appartiene all’esecuzione richiesta. Aggiorna la scheda.');
        context.executionId = null;
        return parent;
    }
    if (options.write && !options.replay) await synchronizeActivityRecurrence(context, board, parent, transaction);
    context.parentActivity = parent;
    const requested = options.executionId == null ? null : parseActivityId(options.executionId, 'executionId');
    const selectedId = requested ?? parent.currentExecutionId;
    if (!selectedId) {
        context.executionId = null;
        if (options.write && !options.management) throw new ActivityError('ACTIVITY_EXECUTION_NOT_STARTED', 409,
            'La prima esecuzione non è ancora iniziata. Puoi modificare la configurazione della ripetizione.');
        return parent;
    }
    const execution = await ActivityExecution.schema(context.schema).findOne({where: {id: selectedId, activityId: parent.id}, transaction});
    if (!execution) throw new ActivityError('ACTIVITY_NOT_FOUND', 404, 'Questa esecuzione non è disponibile.');
    if (options.write && !options.replay) await sealActivityExecution(context, parent, execution, transaction);
    context.executionId = execution.id;
    context.execution = execution;
    context.historicalExecution = !!requested;
    if (!options.replay && options.expectedExecutionId !== undefined && options.expectedExecutionId !== selectedId) {
        throw new ActivityError('ACTIVITY_EXECUTION_CHANGED', 409,
            'È iniziata un’altra esecuzione. La modifica precedente non è stata applicata alla giornata nuova.');
    }
    if (options.write && !options.replay) {
        if (!options.management && options.expectedExecutionId !== selectedId) throw new ActivityError('ACTIVITY_EXECUTION_CHANGED', 409,
            'Aggiorna la scheda prima di modificare questa esecuzione.');
        if ((parent.archivedAt || execution.archivedAt) && !options.management) throw new ActivityError('ACTIVITY_READ_ONLY', 409,
            'Ripristina l’attività prima di modificare le sue esecuzioni.');
        if (execution.closedAt && !requested && !options.management) throw new ActivityError('ACTIVITY_EXECUTION_CLOSED', 409,
            'La giornata è conclusa. Aprila dalla cronologia per registrare un aggiornamento successivo alla scadenza.');
    }
    return requested ? executionActivity(context) : parent;
}

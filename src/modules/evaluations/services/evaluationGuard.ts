import Evaluation from '../models/evaluation.model.js';

/** Errore applicativo con statusCode, gestito da errorHandler.ts. */
function httpError(statusCode: number, message: string): Error {
    const err = new Error(message) as Error & { statusCode: number };
    err.statusCode = statusCode;
    return err;
}

function isSameDay(a: Date, b: Date): boolean {
    return (
        a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate()
    );
}

/**
 * Una valutazione è modificabile (FASE E) SOLO se è ancora `DRAFT` ed è stata creata OGGI. Con la
 * chiusura ("Salva e chiudi" → `COMPLETED`) o al passaggio di giornata diventa immutabile per sempre:
 * per modificarla si crea una nuova valutazione derivata (`/evaluation/:id/clone`).
 */
export function isEvaluationEditable(evaluation: Evaluation): boolean {
    if (evaluation.get('status') !== 'DRAFT') return false;
    const createdAt = evaluation.get('createdAt') as Date | undefined;
    if (!createdAt) return false;
    return isSameDay(new Date(createdAt), new Date());
}

/**
 * Guardia da chiamare nei save dei sotto-record clinici PRIMA di scrivere: se la valutazione target
 * non è più modificabile risponde `409`. Se `evaluationId` è assente (flusso legacy senza valutazione)
 * non blocca nulla, per retrocompatibilità.
 */
export async function assertEvaluationEditable(schema: string, evaluationId?: string | null): Promise<void> {
    if (!evaluationId) return;
    const evaluation = await Evaluation.schema(schema).findByPk(evaluationId);
    if (!evaluation) {
        throw httpError(404, 'Valutazione non trovata');
    }
    if (!isEvaluationEditable(evaluation)) {
        throw httpError(
            409,
            'La valutazione è chiusa (sola lettura) e non è più modificabile. ' +
                'Duplicala in una nuova valutazione per apportare modifiche.'
        );
    }
}

/** La data della valutazione non può essere futura (FASE E). Ritorna un errore 400 se lo è. */
export function assertNotFutureDate(date?: string | Date | null): void {
    if (!date) return;
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) {
        throw httpError(400, 'Data non valida');
    }
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    if (d.getTime() > endOfToday.getTime()) {
        throw httpError(400, 'La data della valutazione non può essere futura');
    }
}


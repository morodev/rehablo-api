import {treasuryError} from './treasuryValidation.service.js';
import {isValidPaymentDate} from '../../invoice/services/appointmentPayment.service.js';

export const TRANSFER_SOURCES = ['TRANSFER_OUT', 'TRANSFER_IN', 'TRANSFER_VOID_OUT', 'TRANSFER_VOID_IN'] as const;
export const isInternalTransfer = (row: Record<string, any>): boolean => (TRANSFER_SOURCES as readonly string[]).includes(row.sourceType);
export const economicMovements = <T extends Record<string, any>>(rows: T[]): T[] => rows.filter(row => !isInternalTransfer(row));
export const cents = (value: unknown): number => Math.round(Number(value) * 100);
export const financialMoney = (value: unknown): number => cents(value) / 100;
export function positiveFinancialAmount(value: unknown): number {
    const amount = Number(value);
    if (!['string', 'number'].includes(typeof value) || !Number.isFinite(amount) || amount <= 0 || amount > 9999999999.99
        || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) treasuryError('Inserisci un importo positivo con al massimo due decimali', 422);
    return financialMoney(amount);
}
/** Date-only controls refer to a Rome calendar day; never reject today's date because noon has not passed yet. */
export function financialDate(value: unknown = new Date()): Date {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && !isValidPaymentDate(value.slice(0, 10))) treasuryError('Indica una data valida e non futura', 422);
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        if (!isValidPaymentDate(value)) treasuryError('Indica una data valida e non futura', 422);
        return new Date(value + 'T12:00:00.000Z');
    }
    const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : new Date(NaN);
    if (!Number.isFinite(parsed.getTime()) || parsed.getTime() > Date.now()) treasuryError('Indica una data valida e non futura', 422);
    return parsed;
}
export function financialNote(value: unknown, required = false): string | null {
    if (value != null && typeof value !== 'string') treasuryError('Inserisci una descrizione valida', 422);
    const note = String(value ?? '').trim();
    if ((required && note.length < 3) || note.length > 1000) treasuryError(required ? 'Indica il motivo della correzione (3–1000 caratteri)' : 'Descrizione troppo lunga', 422);
    return note || null;
}

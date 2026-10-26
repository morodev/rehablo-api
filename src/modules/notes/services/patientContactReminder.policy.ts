import {isPlausibleEmail} from '../../invoice/utils/invoiceShare.js';
import {quotePhone} from '../../administration/services/quoteContact.js';

export const CONTACT_REMINDER_SOURCE = 'PATIENT_MISSING_CONTACTS';
const formatter = new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
function parts(date: Date): Record<string, number> {return Object.fromEntries(formatter.formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));}
function romeNine(date: Date, nextDay = false): Date {
    const local = parts(date), civil = new Date(Date.UTC(local.year, local.month - 1, local.day + Number(nextDay), 9));
    const expected = civil.getTime(); let guess = expected;
    for (let index = 0; index < 3; index++) {
        const value = parts(new Date(guess));
        guess += expected - Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
    }
    return new Date(guess);
}
export function isPatientContactReminder(row: Record<string, any>): boolean {return row.sourceType === CONTACT_REMINDER_SOURCE;}
export function usableContactPhone(value: unknown, country?: unknown): boolean {
    return typeof value === 'string' && /^[+\d\s()./-]+$/.test(value.trim()) && !!quotePhone(value, country);
}
export function sameRomeReminderDay(left: Date, right: Date): boolean {
    const a = parts(left), b = parts(right); return a.year === b.year && a.month === b.month && a.day === b.day;
}
export function hasUsablePatientContact(patient: Record<string, any>): boolean {
    return (Array.isArray(patient.emails) && patient.emails.some(entry => isPlausibleEmail(entry?.email)))
        || isPlausibleEmail(patient.contactEmail)
        || (Array.isArray(patient.phoneNumbers) && patient.phoneNumbers.some(entry => usableContactPhone(entry?.phoneNumber, entry?.country)))
        || usableContactPhone(patient.contactMobilePhone) || usableContactPhone(patient.contactPhone);
}
export function tomorrowContactReminderAt(now = new Date()): Date {return romeNine(now, true);}
export function contactReminderOccurrenceAt(reminder: Record<string, any>, reference = new Date()): Date | null {
    if (!isPatientContactReminder(reminder)) return null;
    const anchor = new Date(reminder.remindAt ?? reminder.dueAt ?? NaN);
    if (!Number.isFinite(anchor.getTime())) return null;
    if (['DONE', 'CANCELLED'].includes(reminder.status)) return new Date(reminder.completedAt ?? anchor);
    const occurrence = romeNine(reference);
    return occurrence < anchor ? anchor : occurrence;
}
export function dailyContactReminderAlertAt(reminder: Record<string, any>, now = new Date()): Date | null {
    if (!isPatientContactReminder(reminder) || !['OPEN', 'SNOOZED'].includes(reminder.status)) return null;
    const occurrence = contactReminderOccurrenceAt(reminder, now);
    return occurrence && occurrence <= now && romeNine(now).getTime() === occurrence.getTime() ? occurrence : null;
}

export interface ScheduledReminder {
    sourceType?: string | null;
    dueAt?: Date | null;
    remindAt?: Date | null;
    status: string;
}

export function baseReminderAlert(reminder: ScheduledReminder): Date | null {
    return reminder.remindAt ?? reminder.dueAt ?? null;
}

export function dueExternalAlert(
    reminder: ScheduledReminder,
    snoozedUntil: Date | null,
    activatedAt: Date,
    now: Date
): Date | null {
    if (reminder.sourceType === 'PATIENT_MISSING_CONTACTS') return null;
    if (reminder.status !== 'OPEN' && reminder.status !== 'SNOOZED') return null;
    const base = baseReminderAlert(reminder);
    if (!base) return null;
    const scheduled = snoozedUntil && snoozedUntil > base ? snoozedUntil : base;
    return scheduled >= activatedAt && scheduled <= now ? scheduled : null;
}

export function deliveryStillCurrent(
    reminder: ScheduledReminder,
    baseScheduledFor: Date,
    snoozedUntil: Date | null,
    now: Date
): boolean {
    if (reminder.sourceType === 'PATIENT_MISSING_CONTACTS') return false;
    if (reminder.status !== 'OPEN' && reminder.status !== 'SNOOZED') return false;
    const base = baseReminderAlert(reminder);
    return !!base && base.getTime() === baseScheduledFor.getTime()
        && (!snoozedUntil || snoozedUntil <= now);
}

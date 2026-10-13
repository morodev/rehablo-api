export const BILLING_PRICES = { base: 1000, user: 1000, structure: 5000 } as const;
export class BillingError extends Error {
    constructor(public statusCode: number, message: string, public code = 'BILLING_ERROR') { super(message); }
}
export function monthlyAmount(users: number, structures: number): number {
    return BILLING_PRICES.base + (users - 1) * BILLING_PRICES.user + (structures - 1) * BILLING_PRICES.structure;
}
export function validateQuantities(users: unknown, structures: unknown): asserts users is number {
    if (![users, structures].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 10000)) {
        throw new BillingError(422, 'Inserisci quantità intere da 1 a 10000.');
    }
}
export function changeKind(current: { users: number; structures: number }, target: { users: number; structures: number }): 'increase' | 'decrease' {
    validateQuantities(target.users, target.structures);
    const increase = target.users > current.users || target.structures > current.structures;
    const decrease = target.users < current.users || target.structures < current.structures;
    if (increase && decrease) throw new BillingError(422, 'Aggiunte e riduzioni devono essere confermate separatamente.');
    if (!increase && !decrease) throw new BillingError(422, 'Seleziona una quantità diversa da quella attuale.');
    return increase ? 'increase' : 'decrease';
}
export function assertUsageFits(used: { users: number; structures: number }, target: { users: number; structures: number }): void {
    if (target.users < used.users || target.structures < used.structures) throw new BillingError(409, 'La quantità scelta è inferiore ai posti utilizzati. Libera prima i posti necessari.', 'BILLING_CAPACITY_IN_USE');
}
export function billingAccessAllowed(account: { status: string; paidThrough: Date | null } | null, now = Date.now()): boolean {
    return !account || (['active', 'past_due'].includes(account.status) && !!account.paidThrough && new Date(account.paidThrough).getTime() > now);
}
export function effectiveLimits(account: { usersLimit: number; structuresLimit: number; scheduledChange: { users: number; structures: number } | null }): { users: number; structures: number } {
    return { users: Math.min(account.usersLimit, account.scheduledChange?.users ?? account.usersLimit), structures: Math.min(account.structuresLimit, account.scheduledChange?.structures ?? account.structuresLimit) };
}

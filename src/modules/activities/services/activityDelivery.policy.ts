export type DeliveryFailure = {kind: 'retry' | 'failed' | 'uncertain' | 'gone'; code: string};

/** A retry is safe only when the transport explicitly rejected or never reached a provider. */
export function classifyActivityDeliveryFailure(error: unknown): DeliveryFailure {
    const details = error as {statusCode?: number; responseCode?: number; code?: string};
    const status = details?.statusCode ?? details?.responseCode;
    if (details?.statusCode === 404 || details?.statusCode === 410) return {kind: 'gone', code: 'DEVICE_EXPIRED'};
    if (status && (status === 429 || status >= 500 && details?.statusCode !== undefined
        || status >= 400 && status < 500 && details?.responseCode !== undefined)) return {kind: 'retry', code: 'PROVIDER_REJECTED_TEMPORARILY'};
    if (status && status >= 400) return {kind: 'failed', code: 'PROVIDER_REJECTED'};
    if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(details?.code ?? '')) return {kind: 'retry', code: 'PROVIDER_UNREACHABLE'};
    return {kind: 'uncertain', code: 'PROVIDER_RESULT_UNKNOWN'};
}
export function activityRetryAt(attempts: number, now: Date): Date | null {
    return attempts >= 5 ? null : new Date(now.getTime() + 2 ** (Math.max(1, attempts) - 1) * 60_000);
}
export function consentCoversSchedule(enabled: boolean, enabledAt: Date | null, scheduledAt: Date): boolean {
    return enabled && !!enabledAt && enabledAt.getTime() <= scheduledAt.getTime();
}
export function aggregateActivityPushTargets(statuses: readonly string[]): 'PENDING' | 'SENT' | 'FAILED' | 'CANCELLED' | 'UNCERTAIN' {
    if (statuses.some(status => status === 'PENDING' || status === 'PROCESSING')) return 'PENDING';
    if (statuses.includes('UNCERTAIN')) return 'UNCERTAIN';
    if (statuses.includes('FAILED')) return 'FAILED';
    if (statuses.includes('SENT')) return 'SENT';
    return 'CANCELLED';
}

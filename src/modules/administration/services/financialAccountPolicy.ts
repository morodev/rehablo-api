export interface AccountChoice {id: string; structureId?: string | null; isActive?: boolean; currency?: string; name?: string; type?: string}

/** No ordering of accounts is a financial preference. */
export function financialAccountChoice(accounts: readonly AccountChoice[], structureId: string, preferredId?: string | null) {
    const eligible = accounts.filter(account => account.isActive !== false && (account.currency ?? 'EUR') === 'EUR'
        && (!account.structureId || account.structureId === structureId));
    const preferred = eligible.find(account => account.id === preferredId);
    const defaultAccountId = preferred?.id ?? (eligible.length === 1 ? eligible[0].id : null);
    return {accounts: eligible, preferredAccountId: preferred?.id ?? null, defaultAccountId, selectionRequired: eligible.length > 1 && !defaultAccountId,
        willCreateDefaultAccount: eligible.length === 0};
}

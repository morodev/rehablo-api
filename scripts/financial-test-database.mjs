/** Never fall back to the application database, even when no test URL is provided. */
export function requireFinancialTestDatabase(environment = process.env) {
    const value = environment.TEST_FINANCIAL_DATABASE_URL;
    if (!value?.trim()) throw new Error('TEST_FINANCIAL_DATABASE_URL is required; financial integration tests never fall back to DATABASE_URL.');
    let target;
    try { target = new URL(value); } catch { throw new Error('TEST_FINANCIAL_DATABASE_URL must be a PostgreSQL URL.'); }
    if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.hash
        || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname.toLowerCase())) {
        throw new Error('Financial integration tests require a dedicated PostgreSQL database on localhost.');
    }
    let databaseName;
    try { databaseName = decodeURIComponent(target.pathname.slice(1)); }
    catch { throw new Error('The financial integration database name is invalid.'); }
    if (databaseName.length > 63 || !/^[a-z][a-z0-9_]*_financial_test(?:_[a-z0-9_]+)?$/.test(databaseName)) {
        throw new Error('Use a dedicated database named <prefix>_financial_test or <prefix>_financial_test_<run>.');
    }
    if (environment.DATABASE_URL) {
        let ordinary;
        try { ordinary = new URL(environment.DATABASE_URL); }
        catch { throw new Error('Cannot confirm isolation from the ordinary database.'); }
        const endpoint = url => `${['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) ? 'loopback' : url.hostname.toLowerCase()}:${url.port || '5432'}/${decodeURIComponent(url.pathname.slice(1))}`;
        if (endpoint(ordinary) === endpoint(target)) throw new Error('The financial integration database must differ from DATABASE_URL, regardless of credentials.');
    }
    return {databaseUrl: value, databaseName};
}

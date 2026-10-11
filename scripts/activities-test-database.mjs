/** Guard the destructive integration fixture setup before importing application models. */
export function requireActivitiesTestDatabase(environment = process.env) {
    const value = environment.TEST_ACTIVITIES_DATABASE_URL;
    if (!value?.trim()) {
        throw new Error('TEST_ACTIVITIES_DATABASE_URL is required; integration tests never use DATABASE_URL as a fallback.');
    }
    let target;
    try {
        target = new URL(value);
    } catch {
        throw new Error('TEST_ACTIVITIES_DATABASE_URL must be a PostgreSQL URL.');
    }
    if (!['postgres:', 'postgresql:'].includes(target.protocol) || !target.hostname || target.hash) {
        throw new Error('TEST_ACTIVITIES_DATABASE_URL must be a PostgreSQL URL without a fragment.');
    }
    let databaseName;
    try {
        databaseName = decodeURIComponent(target.pathname.slice(1));
    } catch {
        throw new Error('The integration database name is invalid.');
    }
    if (databaseName.length > 63 || !/^[a-z][a-z0-9_]*_activities_test(?:_[a-z0-9_]+)?$/.test(databaseName)) {
        throw new Error('Use a dedicated database named <prefix>_activities_test or <prefix>_activities_test_<run>.');
    }
    const endpoint = url => {
        const hostname = url.hostname.toLowerCase();
        const host = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname) ? 'loopback' : hostname;
        return `${host}:${url.port || '5432'}/${decodeURIComponent(url.pathname.slice(1))}`;
    };
    if (environment.DATABASE_URL) {
        let ordinary;
        try {
            ordinary = new URL(environment.DATABASE_URL);
        } catch {
            throw new Error('DATABASE_URL is invalid; cannot confirm database isolation.');
        }
        if (endpoint(ordinary) === endpoint(target)) {
            throw new Error('The integration database must differ from the ordinary DATABASE_URL, including when credentials differ.');
        }
    }
    return {databaseUrl: value, databaseName};
}

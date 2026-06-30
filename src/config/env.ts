import * as dotenv from 'dotenv';

dotenv.config();

function required(name: string, fallback?: string): string {
    const value = process.env[name] ?? fallback;
    if (value === undefined) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

export const env = {
    nodeEnv: process.env.NODE_ENV || 'development',
    isProduction: process.env.NODE_ENV === 'production',
    port: parseInt(process.env.PORT || '3000', 10),

    databaseUrl: required('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/rehablo'),
    dbSsl: process.env.DB_SSL === 'true',

    jwtSecret: required('JWT_SECRET', 'change-me-please-use-a-long-random-string'),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

    stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',

    emailHost: process.env.EMAIL_HOST || '',
    emailPort: parseInt(process.env.EMAIL_PORT || '465', 10),
    emailSecure: process.env.EMAIL_SECURE !== 'false',
    emailUser: process.env.EMAIL_AUTH_USER || '',
    emailPass: process.env.EMAIL_AUTH_PASS || '',

    corsOrigin: process.env.CORS_ORIGIN || '*'
};


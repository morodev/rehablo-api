import Stripe from 'stripe';
import { BILLING_PRICES, BillingError } from './billing.policy.js';

export function billingEnabled(): boolean { return process.env.REHABLO_BILLING_ENABLED === 'true'; }
export function billingConfigured(): boolean {
    return [process.env.STRIPE_SECRET_KEY, process.env.STRIPE_BILLING_BASE_PRICE_ID, process.env.STRIPE_BILLING_USER_PRICE_ID,
        process.env.STRIPE_BILLING_STRUCTURE_PRICE_ID, process.env.STRIPE_BILLING_WEBHOOK_SECRET, process.env.FRONTEND_URL].every(Boolean);
}
export function billingPriceIds() {
    return { base: process.env.STRIPE_BILLING_BASE_PRICE_ID!, user: process.env.STRIPE_BILLING_USER_PRICE_ID!, structure: process.env.STRIPE_BILLING_STRUCTURE_PRICE_ID! };
}
let client: Stripe | undefined;
export function stripeBilling(): Stripe {
    if (!billingConfigured()) throw new BillingError(503, 'I pagamenti non sono ancora configurati. Contatta l’assistenza.', 'BILLING_NOT_CONFIGURED');
    return client ??= new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-04-10', maxNetworkRetries: 2 });
}
let pricesValidatedAt = 0;
export async function validateBillingPrices(): Promise<void> {
    if (Date.now() - pricesValidatedAt < 300000) return;
    const ids = billingPriceIds();
    if (new Set(Object.values(ids)).size !== 3) throw new BillingError(503, 'Il listino Stripe deve contenere tre prezzi distinti.');
    const prices = await Promise.all(Object.entries(ids).map(async ([key, id]) => [key, await stripeBilling().prices.retrieve(id)] as const));
    for (const [key, price] of prices) {
        if (!price.active || price.currency !== 'eur' || price.unit_amount !== BILLING_PRICES[key as keyof typeof BILLING_PRICES] ||
            price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1 || price.recurring.usage_type !== 'licensed' || price.tax_behavior !== 'exclusive') {
            throw new BillingError(503, 'Il listino Stripe non corrisponde ai prezzi mensili di Rehablo.', 'BILLING_PRICE_MISMATCH');
        }
    }
    pricesValidatedAt = Date.now();
}
export function billingReturnUrl(returnTo: unknown, activation = false, cancelled = false): string {
    const origin = new URL(process.env.FRONTEND_URL!);
    if (!['http:', 'https:'].includes(origin.protocol) || (process.env.NODE_ENV === 'production' && origin.protocol !== 'https:')) throw new BillingError(503, 'URL frontend dei pagamenti non valido.');
    const params = new URLSearchParams();
    if (!activation) params.set('panel', returnTo === 'team' ? 'team' : returnTo === 'premises' ? 'premises' : 'plan-billing');
    params.set('billingReturn', cancelled ? 'cancelled' : '1');
    const url = new URL('/', origin);
    url.hash = `${activation ? '/activate-subscription' : '/pages/settings'}?${params}`;
    return url.toString();
}

import webpush from 'web-push';
import {env} from '../../../config/env.js';
import {frontendEmailLink, transporter} from '../../../services/email.service.js';
import type ReminderPushSubscription from '../../notes/models/reminderPushSubscription.model.js';
import {getPushPublicKey} from '../../notes/services/reminderExternalDelivery.service.js';

export interface ActivityDeliveryAddress {tenantId: string; structureId: string; activityId: string; deliveryId: string;}
export interface ActivityDeliveryTransport {
    email(to: string, address: ActivityDeliveryAddress): Promise<string | null>;
    push(subscription: ReminderPushSubscription, address: ActivityDeliveryAddress): Promise<string | null>;
}
export function activityNotificationPath(address: ActivityDeliveryAddress): string {
    return 'activities/open?' + new URLSearchParams({tenantId: address.tenantId, structureId: address.structureId, activityId: address.activityId});
}
let vapidConfigured = false;
const productionTransport: ActivityDeliveryTransport = {
    async email(to, address) {
        const link = frontendEmailLink(activityNotificationPath(address));
        const result = await transporter.sendMail({
            from: {name: 'Attività Rehablo', address: env.emailFrom}, to, subject: 'Hai un’attività su Rehablo',
            text: `Hai un’attività da controllare su Rehablo. Apri ${link}`,
            html: `<p>Hai un’attività da controllare su Rehablo.</p><p><a href="${link.replaceAll('&', '&amp;')}">Apri l’attività</a></p>`
        });
        return typeof result.messageId === 'string' ? result.messageId.slice(0, 255) : null;
    },
    async push(subscription, address) {
        if (!vapidConfigured) {
            const key = getPushPublicKey();
            if (!key) throw Object.assign(new Error('CHANNEL_UNAVAILABLE'), {statusCode: 400});
            webpush.setVapidDetails(`mailto:${env.emailFrom}`, key, process.env.WEB_PUSH_VAPID_PRIVATE_KEY!.trim());
            vapidConfigured = true;
        }
        const result = await webpush.sendNotification({endpoint: subscription.endpoint,
            keys: {p256dh: subscription.p256dh, auth: subscription.auth}}, JSON.stringify({
            version: 1, kind: 'activity', title: 'Attività Rehablo', body: 'Hai un’attività da controllare.',
            tenantId: address.tenantId, structureId: address.structureId, activityId: address.activityId,
            url: '/#/' + activityNotificationPath(address), tag: 'rehablo-activity-' + address.deliveryId
        }), {TTL: 3600, urgency: 'normal', timeout: 20_000});
        return typeof result.headers?.location === 'string' ? result.headers.location.slice(0, 255) : null;
    }
};

/** Tests inject a transport per sweep; production cannot accidentally retain a test override. */
export function defaultActivityDeliveryTransport(): ActivityDeliveryTransport {return productionTransport;}
export async function withActivityProviderTimeout<T>(operation: Promise<T>, timeoutMs = 20_000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('PROVIDER_RESULT_UNKNOWN'), {code: 'ETIMEDOUT'})), timeoutMs);
            timer.unref();
        })]);
    } finally {if (timer) clearTimeout(timer);}
}

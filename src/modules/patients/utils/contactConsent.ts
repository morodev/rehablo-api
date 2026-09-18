/**
 * Regole di consenso per le comunicazioni di servizio dirette al paziente.
 *
 * I consensi sono a tre stati e la distinzione conta:
 *   - `null`      il paziente non è mai stato interpellato
 *   - `true`      ha acconsentito
 *   - `false`     ha rifiutato
 *
 * Solo il rifiuto esplicito blocca l'invio. Le anagrafiche caricate prima dell'introduzione
 * di questi campi hanno `null` e devono continuare a ricevere le conferme come sempre:
 * confermare un appuntamento è esecuzione del contratto (art. 6.1.b GDPR), non marketing,
 * quindi non è il consenso a legittimare l'invio. Il campo serve a rispettare la scelta del
 * paziente sul canale, e a documentarla.
 */
export function contactChannelAllowed(consent: unknown): boolean {
    return consent !== false;
}

/** Primo indirizzo email utilizzabile fra quelli in anagrafica. */
export function firstUsableEmail(emails: unknown): string | null {
    if (!Array.isArray(emails)) return null;
    for (const entry of emails) {
        const email = (entry as { email?: unknown })?.email;
        if (typeof email === 'string' && email.trim()) return email.trim();
    }
    return null;
}

/**
 * Decide se mandare la mail di conferma per un appuntamento appena creato.
 * Il consenso va letto dall'anagrafica viva, non dallo snapshot congelato nell'evento:
 * una revoca deve avere effetto immediato.
 */
export function shouldSendAppointmentEmail(
    patientSnapshot: unknown,
    emailNotificationsConsent: unknown
): boolean {
    const emails = (patientSnapshot as { emails?: unknown })?.emails;
    return Boolean(firstUsableEmail(emails)) && contactChannelAllowed(emailNotificationsConsent);
}

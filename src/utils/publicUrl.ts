/**
 * Verifica che un URL sia utilizzabile in un messaggio inviato all'esterno.
 *
 * Nasce da un problema concreto: con `EMAIL_DOMAIN` non configurato i link vengono costruiti su
 * `http://localhost:4200`. L'email li mostra comunque come collegamento (è HTML), ma WhatsApp
 * trasforma in link solo il testo che riconosce come URL pubblico: un host senza TLD valido
 * (`localhost`, un nome di container) o un indirizzo IP resta testo semplice e il paziente non
 * può aprirlo. Il difetto è invisibile a chi invia, quindi va segnalato dove si configura.
 */

export function isPubliclyShareableUrl(value: string | null | undefined): boolean {
    let parsed: URL;
    try {
        parsed = new URL(`${value ?? ''}`);
    } catch {
        return false;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
    }

    const host = parsed.hostname.toLowerCase();

    // Gli indirizzi IP non vengono linkificati dai client di messaggistica e comunque non sono
    // raggiungibili dal telefono del paziente.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) {
        return false;
    }

    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
        return false;
    }

    // Serve un dominio con estensione: `rehablo` da solo è un host di rete interna.
    return /\.[a-z]{2,}$/.test(host);
}

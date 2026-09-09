import Nodemailer from 'nodemailer';
import moment from 'moment';
import { env } from '../config/env.js';
import { isPubliclyShareableUrl } from '../utils/publicUrl.js';

export const transporter = Nodemailer.createTransport({
    host: env.emailHost,
    port: env.emailPort,
    secure: env.emailSecure,
    auth: {
        user: env.emailUser,
        pass: env.emailPass
    },
    // Il default di Nodemailer è ~2 minuti: troppo per un fire-and-forget. Se l'host SMTP non è
    // raggiungibile (es. porta filtrata dal provider/hosting cloud), falliamo più velocemente.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000
});

// Il frontend usa HashLocationStrategy (`/#/route`). Normalizziamo anche configurazioni
// storiche che includono già `/#` per evitare link con il frammento duplicato.
const emailDomain = (process.env.EMAIL_DOMAIN || 'http://localhost:4200')
    .replace(/\/+$/, '')
    .replace(/\/#$/, '');

// I link generati qui finiscono anche in messaggi WhatsApp, dove un URL non pubblico resta testo
// non cliccabile: chi invia non se ne accorge, il paziente non può aprire il documento.
if (!isPubliclyShareableUrl(emailDomain)) {
    console.warn(
        `[env] EMAIL_DOMAIN="${emailDomain}" non è un indirizzo pubblico: i link inviati ai pazienti ` +
        'non saranno apribili (su WhatsApp non diventano nemmeno cliccabili). ' +
        'Impostalo sull\'URL pubblico del frontend, es. https://app.rehablo.it'
    );
}

export function frontendEmailLink(path: string): string {
    return `${emailDomain}/#/${path.replace(/^\/+/, '')}`;
}

function sender(name: string): { name: string; address: string } {
    return { name, address: env.emailFrom };
}

function baseTemplate(title: string, bodyHtml: string): string {
    return `<!DOCTYPE html>
<html lang="it">
<head>
    <meta charset="utf-8">
    <title>${title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="background-color:#e9ecef;font-family:Helvetica,Arial,sans-serif;">
<table align="center" width="600" style="max-width:600px;margin:0 auto;background:#fff;">
    <tr><td style="padding:24px;border-top:3px solid #d4dadf;text-align:center;">
        <h1 style="margin:0;font-size:28px;">${title}</h1>
    </td></tr>
    <tr><td style="padding:24px;font-size:16px;line-height:24px;">${bodyHtml}</td></tr>
    <tr><td style="padding:24px;border-bottom:3px solid #d4dadf;">
        <p style="margin:0;">Grazie dal team di<br>Rehablo</p>
    </td></tr>
</table>
</body>
</html>`;
}

export async function signUpSendMail(email: string, verificationToken: string) {
    const link = frontendEmailLink(`account-verification/${verificationToken}`);
    return transporter.sendMail({
        from: sender('Verifica account Rehablo'),
        to: email,
        subject: 'Benvenuto in Rehablo',
        text: `Grazie per esserti registrato su Rehablo. Verifica il tuo account: ${link}`,
        html: baseTemplate(
            'Verifica il tuo account',
            `<p>Clicca sul link sottostante per confermare il tuo indirizzo e-mail.</p>
             <p><a href="${link}" target="_blank">${link}</a></p>`
        )
    });
}

export async function sendNewEventMail(agendaEvent: any) {
    const email = agendaEvent?.patient?.emails?.[0]?.email;
    if (!email) return;

    const name = agendaEvent.patient?.name || '';
    const surname = agendaEvent.patient?.surname || '';
    const day = moment(agendaEvent.start).locale('it').format('dddd');
    const eventDate = moment(agendaEvent.start).locale('it').format('LL');
    const hour = moment(agendaEvent.start).locale('it').format('LT');

    return transporter.sendMail({
        from: sender('Nuovo appuntamento'),
        to: email,
        subject: "Dati di riepilogo per l'appuntamento",
        text: `Ciao ${name} ${surname}, è stato inserito un nuovo appuntamento ${day} ${eventDate} alle ${hour}.`,
        html: baseTemplate(
            'Nuovo appuntamento',
            `<p>Ciao ${name} ${surname},</p>
             <p>è stato fissato un nuovo appuntamento:</p>
             <p><strong>${day} ${eventDate}</strong> alle <strong>${hour}</strong></p>`
        )
    });
}

export async function sendForgotPasswordMail(email: string, resetPasswordToken: string) {
    const link = frontendEmailLink(`reset-password/${resetPasswordToken}`);

    if (!env.isProduction || !env.emailHost) {
        console.log(`[email.service] reset password link for ${email}: ${link}`);
    }

    return transporter.sendMail({
        from: sender('Recupero password Rehablo'),
        to: email,
        subject: 'Recupero password',
        text: `Reimposta la tua password: ${link}`,
        html: baseTemplate(
            'Reimposta la password',
            `<p>Clicca sul link sottostante per procedere con il reset della password.</p>
             <p><a href="${link}" target="_blank">${link}</a></p>`
        )
    });
}

export async function sendPatientPortalInvitationMail(email: string, token: string, centerName: string) {
    const link = frontendEmailLink(`patient-invitation/${token}`);

    if (!env.isProduction || !env.emailHost) {
        console.log(`[email.service] patient portal invitation for ${email}: ${link}`);
    }

    return transporter.sendMail({
        from: sender('Portale paziente Rehablo'),
        to: email,
        subject: `${centerName} ti invita nel portale Rehablo`,
        text: `${centerName} ti ha invitato a consultare i tuoi dati su Rehablo. Accetta l'invito: ${link}`,
        html: baseTemplate(
            'Accedi ai tuoi dati Rehablo',
            `<p><strong>${centerName}</strong> ti ha invitato a consultare la tua cartella, gli appuntamenti e le fatture.</p>
             <p>Il link è personale, monouso e a scadenza.</p>
             <p><a href="${link}" target="_blank">Accetta l'invito</a></p>`
        )
    });
}

/** I dati anagrafici finiscono in un template HTML: senza escaping un apostrofo o un `<` romperebbe il markup. */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Consegna della fattura al paziente.
 *
 * L'email porta un LINK e non un allegato: il documento resta sul server, dietro un token a
 * scadenza e revocabile. Una casella di posta viene inoltrata, archiviata e letta su dispositivi
 * condivisi, e una fattura di fisioterapia rivela prestazioni sanitarie: il link permette di
 * chiudere l'accesso in un secondo momento, cosa che un PDF già spedito non consente.
 */
export async function sendInvoiceMail(input: {
    to: string;
    link: string;
    centerName: string;
    documentLabel: string;
    documentReference: string;
    patientName?: string | null;
    expiresAt: Date;
}) {
    const reference = `${input.documentLabel} ${input.documentReference}`;
    const greeting = input.patientName ? `Ciao ${escapeHtml(input.patientName)},` : 'Buongiorno,';
    const expiry = moment(input.expiresAt).locale('it').format('LL');

    if (!env.isProduction || !env.emailHost) {
        console.log(`[email.service] invoice link for ${input.to}: ${input.link}`);
    }

    return transporter.sendMail({
        from: sender(input.centerName),
        to: input.to,
        subject: `${reference} - ${input.centerName}`,
        text: `${input.patientName ? `Ciao ${input.patientName},` : 'Buongiorno,'}\n\n`
            + `di seguito il link a ${input.documentLabel.toLowerCase()} ${input.documentReference} di ${input.centerName}.\n`
            + `${input.link}\n\n`
            + `Dalla pagina puoi stamparla o salvarla in PDF. Il link resta valido fino al ${expiry}.`,
        html: baseTemplate(
            escapeHtml(reference),
            `<p>${greeting}</p>
             <p>di seguito trovi ${escapeHtml(input.documentLabel.toLowerCase())}
                <strong>${escapeHtml(input.documentReference)}</strong>
                di <strong>${escapeHtml(input.centerName)}</strong>.</p>
             <p><a href="${input.link}" target="_blank">Apri il documento</a></p>
             <p style="color:#6b7280;font-size:14px;">Dalla pagina puoi stamparlo o salvarlo in PDF.
                Il link è personale e resta valido fino al ${expiry}.</p>`
        )
    });
}




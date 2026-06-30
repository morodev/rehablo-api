import Nodemailer from 'nodemailer';
import moment from 'moment';
import { env } from '../config/env.js';

export const transporter = Nodemailer.createTransport({
    host: env.emailHost,
    port: env.emailPort,
    secure: env.emailSecure,
    auth: {
        user: env.emailUser,
        pass: env.emailPass
    }
});

const emailDomain = process.env.EMAIL_DOMAIN || 'http://localhost:4200';

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
    const link = `${emailDomain}/account-verification/${verificationToken}`;
    return transporter.sendMail({
        from: '"Verifica account Rehablo" <verification@rehablo.it>',
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
        from: '"Nuovo appuntamento" <appuntamenti@rehablo.it>',
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
    const link = `${emailDomain}/reset-password/${resetPasswordToken}`;

    if (!env.isProduction || !env.emailHost) {
        console.log(`[email.service] reset password link for ${email}: ${link}`);
    }

    return transporter.sendMail({
        from: '"Recupero password Rehablo" <forgotpassword@rehablo.it>',
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




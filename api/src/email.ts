import nodemailer, { Transporter } from 'nodemailer';

// E-mailverzending — momenteel uitsluitend voor de MFA-inlogcode (zie mfa.ts
// en doelenboom_mfa_ontwerp.md in het project). SMTP-relay via nodemailer,
// generiek genoeg voor vrijwel elke provider (Hostnet's smtp.hostnet.nl in
// dit geval, zie deploy/README.md voor de env-vars).
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
// no-reply.doelenboom@code072.nl is een alias van de mailbox waar we op
// inloggen (SMTP_USER, doorgaans no-reply@code072.nl) — de afzender die de
// ontvanger ziet mag dus afwijken van het account waarmee verstuurd wordt.
const SMTP_FROM = process.env.SMTP_FROM ?? 'no-reply.doelenboom@code072.nl';

// Interne notificatie ("er wacht een aanvraag op (re)actie") bij elke nieuwe
// zelfbedieningsaanvraag (zie createSubscriptionRequest in subscriptions.ts).
// Dit is de ONTVANGER, niet de afzender — apart van SMTP_FROM/SMTP_USER
// hierboven. Instelbaar via env (Charles, 16 september 2026: "wil ik dat er
// een mail wordt gestuurd ... zodat ik geinformeerd wordt dat iemand op
// (re)actie wacht"), met een vaste standaardwaarde zodat dit ook zonder extra
// configuratie meteen werkt.
const SUBSCRIPTION_REQUEST_NOTIFY_EMAIL =
  process.env.SUBSCRIPTION_REQUEST_NOTIFY_EMAIL ?? 'info.doelenboom@code072.nl';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!SMTP_HOST) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      // 465 = impliciet TLS vanaf de eerste byte ("SSL/TLS"); elke andere
      // poort (587 gebruikelijk, "STARTTLS") begint ongeversleuteld en
      // upgradet zelf — dat regelt nodemailer automatisch als secure:false.
      secure: SMTP_PORT === 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASSWORD } : undefined,
      // Nodemailer's eigen standaardwaarden zijn (veel) te ruim voor een
      // aanroep die middenin een login-request hangt (2 min. om te verbinden,
      // tot 10 min. socket-inactiviteit) — bij een onbereikbare relay/
      // firewall/verkeerd wachtwoord bleef de hele /login-aanvraag daardoor
      // eindeloos op "Bezig…" hangen i.p.v. binnen een paar seconden een
      // duidelijke fout te geven. Ruim genoeg voor een trage maar werkende
      // relay, kort genoeg om niet als een nieuwe "hangt"-klacht aan te voelen.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }
  return transporter;
}

function renderMfaEmail(code: string, ttlMinutes: number): { text: string; html: string } {
  const text =
    `Je Doelenboom-inlogcode is: ${code}\n\n` +
    `Deze code is ${ttlMinutes} minuten geldig.\n\n` +
    `Probeerde je zelf niet in te loggen? Dan kun je deze e-mail negeren.`;
  const html =
    `<p>Je Doelenboom-inlogcode is:</p>` +
    `<p style="font-size:28px;font-weight:700;letter-spacing:4px;font-family:monospace">${code}</p>` +
    `<p>Deze code is ${ttlMinutes} minuten geldig.</p>` +
    `<p style="color:#6c6f76;font-size:13px">Probeerde je zelf niet in te loggen? Dan kun je deze e-mail negeren.</p>`;
  return { text, html };
}

// Los, vervangbaar exportbinding (bewust `let`, geen `const`) zodat
// api/test/mfa.test.ts hier met setSendMfaEmailImpl() een mock-implementatie
// in kan hangen die de verstuurde code opvangt i.p.v. écht te mailen — een
// module-namespace-object is in ESM niet herschrijfbaar (mock.method uit
// node:test zou hier dus niet op werken), een losse herwijsbare `let`-binding
// binnen deze module wel.
export let sendMfaEmail = async (to: string, code: string, ttlMinutes = 10): Promise<void> => {
  const transport = getTransporter();
  const { text, html } = renderMfaEmail(code, ttlMinutes);
  if (!transport) {
    // Lokale dev-fallback (geen SMTP_HOST gezet) — zelfde stijl als de
    // JWT_SECRET-fallback in auth.ts: duidelijk zichtbaar, niet stil, maar
    // ook geen crash. Laat de hele MFA-flow lokaal te testen zijn vóórdat er
    // een echte SMTP-relay is aangesloten.
    console.warn(`WAARSCHUWING: geen SMTP_HOST geconfigureerd — MFA-code voor ${to} is: ${code} (alleen in deze console, niet gemaild).`);
    return;
  }
  await transport.sendMail({ from: SMTP_FROM, to, subject: 'Je Doelenboom-inlogcode', text, html });
};

export function setSendMfaEmailImpl(fn: typeof sendMfaEmail): void {
  sendMfaEmail = fn;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export interface NewSubscriptionRequestNotification {
  requestId: number;
  organizationName: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string | null;
  tierName: string;
  billingPeriod: 'maand' | 'jaar';
  priceEur: number | null;
  trialEndDate: string;
}

function renderNewSubscriptionRequestEmail(
  n: NewSubscriptionRequestNotification
): { subject: string; text: string; html: string } {
  const periodLabel = n.billingPeriod === 'maand' ? 'per maand' : 'per jaar';
  const priceLabel = n.priceEur != null ? `€ ${n.priceEur.toLocaleString('nl-NL')} ${periodLabel}` : 'onbekend';
  const contactLine = `${n.applicantName} <${n.applicantEmail}>${n.applicantPhone ? ` — ${n.applicantPhone}` : ''}`;
  const subject = `Nieuwe abonnementsaanvraag: ${n.organizationName}`;
  const text =
    `Er is een nieuwe abonnementsaanvraag binnengekomen die op (re)actie wacht.\n\n` +
    `Organisatie: ${n.organizationName}\n` +
    `Aanvrager: ${contactLine}\n` +
    `Tier: ${n.tierName}\n` +
    `Prijs: ${priceLabel}\n` +
    `Proefperiode tot: ${n.trialEndDate}\n` +
    `Aanvraag-ID: ${n.requestId}`;
  const row = (label: string, value: string) =>
    `<tr><td style="padding:2px 12px 2px 0;color:#6c6f76">${label}</td><td>${value}</td></tr>`;
  const html =
    `<p>Er is een nieuwe abonnementsaanvraag binnengekomen die op (re)actie wacht.</p>` +
    `<table style="border-collapse:collapse">` +
    row('Organisatie', escapeHtml(n.organizationName)) +
    row(
      'Aanvrager',
      `${escapeHtml(n.applicantName)} &lt;${escapeHtml(n.applicantEmail)}&gt;` +
        (n.applicantPhone ? ` — ${escapeHtml(n.applicantPhone)}` : '')
    ) +
    row('Tier', escapeHtml(n.tierName)) +
    row('Prijs', escapeHtml(priceLabel)) +
    row('Proefperiode tot', escapeHtml(n.trialEndDate)) +
    row('Aanvraag-ID', String(n.requestId)) +
    `</table>`;
  return { subject, text, html };
}

// Zelfde `let`-exportbinding-patroon als sendMfaEmail hierboven, om dezelfde
// reden mockbaar vanuit api/test/helpers.ts (setSendNewSubscriptionRequestEmailImpl).
export let sendNewSubscriptionRequestEmail = async (
  notification: NewSubscriptionRequestNotification
): Promise<void> => {
  const transport = getTransporter();
  const { subject, text, html } = renderNewSubscriptionRequestEmail(notification);
  if (!transport) {
    console.warn(
      `WAARSCHUWING: geen SMTP_HOST geconfigureerd — notificatie voor nieuwe aanvraag #${notification.requestId} ` +
        `(${notification.organizationName}) is niet gemaild (zou naar ${SUBSCRIPTION_REQUEST_NOTIFY_EMAIL} gaan).`
    );
    return;
  }
  await transport.sendMail({ from: SMTP_FROM, to: SUBSCRIPTION_REQUEST_NOTIFY_EMAIL, subject, text, html });
};

export function setSendNewSubscriptionRequestEmailImpl(fn: typeof sendNewSubscriptionRequestEmail): void {
  sendNewSubscriptionRequestEmail = fn;
}

// --- Verificatiemail voor de publieke zelfbedieningsaanvraag (DOEL-20) ---
// Zelfde `let`-exportbinding-patroon als hierboven (mockbaar via
// setSendRegistrationVerificationEmailImpl in api/test/helpers.ts).

function renderRegistrationVerificationEmail(
  link: string,
  organizationName: string,
  ttlHours: number
): { subject: string; text: string; html: string } {
  const subject = 'Bevestig je Doelenboom-aanvraag';
  const text =
    `Je hebt een Doelenboom-proefaccount aangevraagd voor ${organizationName}.\n\n` +
    `Bevestig je e-mailadres om het account aan te maken:\n${link}\n\n` +
    `Deze link is ${ttlHours} uur geldig en kan één keer gebruikt worden.\n\n` +
    `Heb je dit niet zelf aangevraagd? Dan kun je deze e-mail negeren; er wordt dan niets aangemaakt.`;
  const html =
    `<p>Je hebt een Doelenboom-proefaccount aangevraagd voor <strong>${escapeHtml(organizationName)}</strong>.</p>` +
    `<p>Bevestig je e-mailadres om het account aan te maken:</p>` +
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#2F5597;color:#fff;border-radius:6px;text-decoration:none">Aanvraag bevestigen</a></p>` +
    `<p style="color:#6c6f76;font-size:13px">Werkt de knop niet? Kopieer dan deze link in je browser:<br>${escapeHtml(link)}</p>` +
    `<p style="color:#6c6f76;font-size:13px">Deze link is ${ttlHours} uur geldig en kan één keer gebruikt worden. ` +
    `Heb je dit niet zelf aangevraagd? Dan kun je deze e-mail negeren; er wordt dan niets aangemaakt.</p>`;
  return { subject, text, html };
}

export let sendRegistrationVerificationEmail = async (
  to: string,
  link: string,
  organizationName: string,
  ttlHours: number
): Promise<void> => {
  const transport = getTransporter();
  const { subject, text, html } = renderRegistrationVerificationEmail(link, organizationName, ttlHours);
  if (!transport) {
    // De link is een bearer-geheim: buiten productie tonen we hem voor lokale
    // dev (geen SMTP), in productie nooit in de logs.
    if (process.env.NODE_ENV === 'production') {
      console.error(`FOUT: geen SMTP_HOST geconfigureerd — verificatiemail voor ${to} kon niet verstuurd worden; aanvragen kunnen niet bevestigd worden.`);
    } else {
      console.warn(`WAARSCHUWING: geen SMTP_HOST geconfigureerd — verificatielink voor ${to} is: ${link} (alleen in deze console, niet gemaild).`);
    }
    return;
  }
  await transport.sendMail({ from: SMTP_FROM, to, subject, text, html });
};

export function setSendRegistrationVerificationEmailImpl(fn: typeof sendRegistrationVerificationEmail): void {
  sendRegistrationVerificationEmail = fn;
}

// Voor een aanvraag met een e-mailadres dat al een account heeft: dezelfde
// (generieke) respons aan de aanvrager als bij een nieuw adres, maar de
// eigenaar van het adres krijgt deze mail i.p.v. een verificatielink. Zo is
// het bestaan van een account niet te achterhalen door een aanvraag in te
// dienen (account-enumeratie), terwijl de echte eigenaar wel weet wat er speelt.
export let sendRegistrationExistingAccountEmail = async (to: string, loginUrl: string): Promise<void> => {
  const transport = getTransporter();
  const subject = 'Je hebt al een Doelenboom-account';
  const text =
    `Iemand heeft met dit e-mailadres een Doelenboom-proefaccount aangevraagd, maar er bestaat al een account.\n\n` +
    `Log gewoon in: ${loginUrl}\n` +
    `Wachtwoord vergeten? Vraag de beheerder van je organisatie om een nieuw wachtwoord.\n\n` +
    `Was jij dit niet? Dan kun je deze e-mail negeren; er is niets gewijzigd.`;
  const html =
    `<p>Iemand heeft met dit e-mailadres een Doelenboom-proefaccount aangevraagd, maar er bestaat al een account.</p>` +
    `<p><a href="${escapeHtml(loginUrl)}">Log gewoon in</a>. Wachtwoord vergeten? Vraag de beheerder van je organisatie om een nieuw wachtwoord.</p>` +
    `<p style="color:#6c6f76;font-size:13px">Was jij dit niet? Dan kun je deze e-mail negeren; er is niets gewijzigd.</p>`;
  if (!transport) {
    console.warn(`WAARSCHUWING: geen SMTP_HOST geconfigureerd — 'account bestaat al'-mail voor ${to} niet gemaild.`);
    return;
  }
  await transport.sendMail({ from: SMTP_FROM, to, subject, text, html });
};

export function setSendRegistrationExistingAccountEmailImpl(fn: typeof sendRegistrationExistingAccountEmail): void {
  sendRegistrationExistingAccountEmail = fn;
}

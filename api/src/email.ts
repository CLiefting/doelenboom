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

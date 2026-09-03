import nodemailer, { Transporter } from 'nodemailer';

// E-mailverzending — momenteel uitsluitend voor de MFA-inlogcode (zie mfa.ts
// en doelenboom_mfa_ontwerp.md in het project). SMTP-relay via nodemailer,
// generiek genoeg voor vrijwel elke provider (Hostnet's mailout.hostnet.nl in
// dit geval, zie deploy/README.md voor de env-vars).
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
const SMTP_FROM = process.env.SMTP_FROM ?? 'no-reply@code072.nl';

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

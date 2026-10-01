// E-mailadressen valideren (DOEL-67, OWASP A03).
//
// Aanleiding: nodemailer (ook 10.x) interpreteert een "to"-waarde als een
// RFC 5322-adreslijst. Een komma of puntkomma levert dus extra ontvangers op,
// en "slachtoffer@x.nl\r\nBcc: aanvaller@y.nl" stuurde de mail in een test
// zelfs ALLEEN naar het adres van de aanvaller. Accounts die een sysadmin
// (routes/users.ts) of tenant-admin (routes/tenants.ts, leden) aanmaakt
// werden tot nu toe zonder adrescontrole opgeslagen, en daar gaat o.a. de
// MFA-code naartoe. Daarom twee lagen:
//   1. isValidEmailAddress — strikte controle bij INVOER (één kaal adres,
//      geen weergavenaam, geen lijst, geen commentaar, geen witruimte);
//   2. assertSafeRecipient — vangnet vlak vóór elke sendMail (email.ts), voor
//      adressen die al vóór deze controle in de database stonden. Bewust
//      ruimer dan (1): weigert alleen wat nodemailer als lijst/header/
//      commentaar kan opvatten, zodat een legitiem bestaand adres niet
//      ineens geen MFA-mail meer krijgt.

export const MAX_EMAIL_LENGTH = 254;

// Lokaal deel: de "atext"-tekens uit RFC 5322 plus punt (geen quoted-string).
// Domein: labels van letters/cijfers/koppeltekens, minstens één punt.
const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function isValidEmailAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(value);
}

// Tekens waarmee nodemailer's addressparser een adres opsplitst of als
// header/weergavenaam/commentaar leest.
const UNSAFE_RECIPIENT_CHARS = /[\r\n\t ,;:<>"()[\]\\]/;

export class UnsafeRecipientError extends Error {
  constructor() {
    super('Ongeldig ontvangeradres; e-mail niet verstuurd.');
    this.name = 'UnsafeRecipientError';
  }
}

export function assertSafeRecipient(to: string): void {
  if (
    typeof to !== 'string' ||
    !to ||
    to.length > MAX_EMAIL_LENGTH ||
    UNSAFE_RECIPIENT_CHARS.test(to) ||
    to.split('@').length !== 2
  ) {
    throw new UnsafeRecipientError();
  }
}

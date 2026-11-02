// DOEL-131: in welke omgeving draait deze API (ontwikkeling, acceptatie of
// productie)? De web-app toont op basis hiervan linksboven een gekleurde
// driehoek (groen = ontwikkeling, geel = acceptatie, niets in productie) en
// zet "[ONT]"/"[ACC]" voor de tabbladtitel.
//
// Bron: DOELENBOOM_OMGEVING, gezet in docker-compose.yml (ontwikkeling),
// docker-compose.acc.yml (acceptatie), docker-compose.prod.yml (productie) en
// docker-compose.kluis.yml (kluis, DOEL-133).
//
// DOEL-133: de KLUIS is een lokale omgeving op de Mac van Charles voor
// doelenbomen met gevoelige(re) informatie. Hij draait altijd dezelfde versie
// als productie (scripts/release.sh werkt hem bij) en gedraagt zich verder als
// productie, maar: rode driehoek "VAULT", mails met "[VAULT]", en alles wat
// eruit geëxporteerd wordt, is gemarkeerd als gevoelig (zie isGevoeligeOmgeving
// en gevoeligeBestandsnaam hieronder). Andere omgevingen weigeren zulke bestanden.
// De waarde wordt bij het draaien gelezen, niet bij het bouwen: acceptatie en
// productie gebruiken dezelfde Dockerfiles.
//
// Leeg of niet gezet telt als productie (zelfde regel als het mail-label in
// email.ts, DOEL-127). Elke andere waarde dan de drie hieronder is een
// configuratiefout: dan weigert de API te starten (assertValidOmgeving, in
// createApp), zodat je nooit ongemerkt zonder driehoek in acceptatie werkt
// (OWASP A05, Security Misconfiguration).

export const OMGEVINGEN = ['ontwikkeling', 'acceptatie', 'productie', 'kluis'] as const;
export type Omgeving = (typeof OMGEVINGEN)[number];

export class InvalidOmgevingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOmgevingError';
  }
}

export function parseOmgeving(raw: string | undefined): Omgeving {
  const v = (raw ?? '').trim();
  if (v === '') return 'productie';
  if ((OMGEVINGEN as readonly string[]).includes(v)) return v as Omgeving;
  // De ruwe waarde wordt bewust niet herhaald in de foutmelding (die komt in
  // de containerlog); alleen de lengte, zodat een typefout te herkennen is.
  throw new InvalidOmgevingError(
    `DOELENBOOM_OMGEVING heeft een ongeldige waarde (${v.length} tekens). ` +
      `Toegestaan: ${OMGEVINGEN.join(', ')} (of leeg = productie). De API start niet.`
  );
}

export function currentOmgeving(): Omgeving {
  return parseOmgeving(process.env.DOELENBOOM_OMGEVING);
}

export function assertValidOmgeving(): void {
  currentOmgeving();
}

// DOEL-133: alles in de kluis is gevoelig.
export function isGevoeligeOmgeving(omgeving: Omgeving = currentOmgeving()): boolean {
  return omgeving === 'kluis';
}

// DOEL-133: "GEVOELIG_" vóór de bestandsnaam van elke download uit de kluis
// (Excel en PowerPoint), zodat een los rondslingerend bestand herkenbaar is.
export function gevoeligeBestandsnaam(filename: string, omgeving: Omgeving = currentOmgeving()): string {
  return isGevoeligeOmgeving(omgeving) ? `GEVOELIG_${filename}` : filename;
}

// DOEL-133: melding als een gemarkeerd (gevoelig) bestand buiten de kluis
// wordt ingelezen.
export const GEVOELIG_GEWEIGERD =
  'Dit bestand komt uit de kluis (gevoelige gegevens) en mag alleen in de kluis worden ingelezen. Er is niets ingelezen.';

// Wat GET /api/version meegeeft. In productie niets: daar is geen driehoek, en
// zo geeft productie geen extra informatie prijs.
export function omgevingVoorWeb(omgeving: Omgeving = currentOmgeving()): { omgeving?: Omgeving } {
  return omgeving === 'productie' ? {} : { omgeving };
}

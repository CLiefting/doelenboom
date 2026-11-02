// DOEL-131: weergave van de omgeving waarin je werkt. Linksboven op elke pagina
// een driehoek (groen "ONT" = ontwikkeling, geel "ACC" = acceptatie, rood
// "VAULT" = de lokale kluis met gevoelige gegevens, DOEL-133) en de
// tabbladtitel krijgt "[ONT] ", "[ACC] " of "[VAULT] " vooraan. In productie niets.
//
// De omgeving komt van GET /api/version (veld "omgeving", alleen buiten
// productie, zie api/src/omgeving.ts). Alles wat geen bekende waarde is,
// levert géén driehoek op: de API weigert zelf al te starten met een
// ongeldige omgeving, dus hier hoeft niets te worden geraden.
//
// Bewust zonder React/JSX en zonder TypeScript-only constructies, zodat
// web/test/omgeving.test.mjs dit bestand rechtstreeks met Node kan laden.

export type DriehoekWeergave = {
  label: 'ONT' | 'ACC' | 'VAULT';
  achtergrond: string;
  tekstkleur: string;
  omschrijving: string;
};

// DOEL-134: de driehoek is half doorzichtig (de achtergrondkleur met deze
// dekking), zodat tekst en knoppen eronder zichtbaar blijven (Charles,
// 02-11-2026). Daarom donkere letters in een tint van dezelfde kleur, met een
// lichte halo (zie OmgevingsDriehoek.tsx): contrast ≥ 4,5:1 tegen de
// doorzichtige kleur op een lichte pagina.
export const DRIEHOEK_DEKKING = 0.45;

const WEERGAVE: Record<string, DriehoekWeergave> = {
  ontwikkeling: { label: 'ONT', achtergrond: '#2E7D32', tekstkleur: '#0D3B12', omschrijving: 'Ontwikkelomgeving' },
  acceptatie: { label: 'ACC', achtergrond: '#FFC107', tekstkleur: '#1A1A1A', omschrijving: 'Acceptatieomgeving' },
  // DOEL-133: de lokale kluis met gevoelige doelenbomen.
  kluis: { label: 'VAULT', achtergrond: '#C62828', tekstkleur: '#7A0000', omschrijving: 'Kluisomgeving met gevoelige gegevens (VAULT)' },
};

// "#RRGGBB" + dekking -> "rgba(r, g, b, a)".
export function doorzichtig(hex: string, dekking: number = DRIEHOEK_DEKKING): string {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${dekking})`;
}

export function driehoekVoor(omgeving: unknown): DriehoekWeergave | null {
  if (typeof omgeving !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(WEERGAVE, omgeving) ? WEERGAVE[omgeving] : null;
}

// Zet "[ACC] " of "[ONT] " vóór de titel. Idempotent: een titel die al een
// omgevingsvoorvoegsel heeft, krijgt geen tweede (bv. bij een tweede render).
export function tabTitel(titel: string, omgeving: unknown): string {
  const kaal = titel.replace(/^\[(ONT|ACC|VAULT)\] /, '');
  const w = driehoekVoor(omgeving);
  return w ? `[${w.label}] ${kaal}` : kaal;
}

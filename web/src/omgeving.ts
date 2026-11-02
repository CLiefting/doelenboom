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

const WEERGAVE: Record<string, DriehoekWeergave> = {
  // Donkergroen, zodat de witte tekst goed leesbaar is (contrast ruim boven 4,5:1).
  ontwikkeling: { label: 'ONT', achtergrond: '#2E7D32', tekstkleur: '#FFFFFF', omschrijving: 'Ontwikkelomgeving' },
  acceptatie: { label: 'ACC', achtergrond: '#FFC107', tekstkleur: '#1A1A1A', omschrijving: 'Acceptatieomgeving' },
  // DOEL-133: de lokale kluis met gevoelige doelenbomen. Donkerrood, zodat de
  // witte tekst goed leesbaar is (contrast ruim boven 4,5:1).
  kluis: { label: 'VAULT', achtergrond: '#C62828', tekstkleur: '#FFFFFF', omschrijving: 'Kluisomgeving met gevoelige gegevens (VAULT)' },
};

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

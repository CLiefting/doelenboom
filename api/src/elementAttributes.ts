import { PoolClient } from 'pg';
import { pool } from './db.js';
import { allValidTypeNames, ColumnDef } from './columnConfig.js';

// Kenmerken (DOEL-75, epic DOEL-61 "Module Controleregels"; ontwerp:
// doelenboom_kenmerken_ontwerp.md): per kolomconfiguratie (doelenboom,
// tenant-default of sjabloon) een lijst DEFINITIES van eigen velden per
// elementtype — "voor elementen van type Capability leggen we het kenmerk
// 'Laatst beoordeeld' (datum) vast". Opslag: column_configs.attributes /
// doelenboom_templates.attributes_snapshot (jsonb, zie
// db/migrations/0047_element_attribute_definitions.sql). Dit bestand bevat
// het schema, de (enige, server-side) validatie en de databasetoegang.
//
// Alleen de definities: de waarden per element volgen in DOEL-76, de regels
// die kenmerken toetsen in DOEL-77. Hoort bij de licentiemodule
// 'controleregels' (CONTROLE_REGELS_MODULE in controlRules.ts).
//
// Uitgangspunt (epic DOEL-61, verruimd 3 oktober 2026): kenmerken zijn
// toegestaan zolang het METAGEGEVENS blijven — geen inhoudelijke of
// gerubriceerde informatie. De soorten zijn een gesloten whitelist en
// onbekende velden worden geweigerd: er komt geen ongecontroleerde
// jsonb-inhoud in de database.

export const ATTRIBUTE_KINDS = ['text', 'number', 'date', 'choice', 'boolean'] as const;
export type AttributeKind = (typeof ATTRIBUTE_KINDS)[number];

export interface AttributeDef {
  // Stabiele sleutel: in DOEL-76 hangen de waarden per element eraan, in
  // DOEL-77 verwijzen regels ernaar. Ligt daarom vast na aanmaken.
  id: string;
  label: string;
  // Ligt vast na aanmaken (een andere soort maakt bestaande waarden
  // betekenisloos); wijzigen = kenmerk verwijderen en nieuw aanmaken.
  kind: AttributeKind;
  // Elementtypen (kolom-typeName of alias) waarvoor het kenmerk geldt.
  subjectTypes: string[];
  required: boolean;
  explanation: string;
  // Alleen bij kind = 'choice': de toegestane waarden (één waarde per element).
  options: string[];
}

export const MAX_ATTRIBUTES = 30;
export const ATTRIBUTE_ID_PATTERN = /^[A-Za-z0-9_-]{1,30}$/;
const MAX_LABEL = 60;
const MAX_EXPLANATION = 300;
const MAX_OPTIONS = 50;
const MAX_OPTION = 60;
const MAX_TYPES_PER_LIST = 50;
const MAX_TYPE_NAME = 200;

const ALLOWED_KEYS = new Set(['id', 'label', 'kind', 'subjectTypes', 'required', 'explanation', 'options']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isUnset(v: unknown): boolean {
  return v === undefined || v === null;
}

// Lijst van niet-lege, getrimde, unieke teksten met een maximum aantal en
// lengte. Geeft null terug (en één foutmelding) als de lijst niet deugt.
function parseStringList(
  raw: unknown,
  where: string,
  what: string,
  limits: { maxItems: number; maxLength: number; rejectDuplicates: boolean },
  errors: string[]
): string[] | null {
  if (isUnset(raw)) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${where}: ${what} moet een lijst van teksten zijn.`);
    return null;
  }
  if (raw.length > limits.maxItems) {
    errors.push(`${where}: ${what} mag maximaal ${limits.maxItems} waarden bevatten.`);
    return null;
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) {
      errors.push(`${where}: ${what} mag alleen niet-lege teksten bevatten.`);
      return null;
    }
    const value = item.trim();
    if (value.length > limits.maxLength) {
      errors.push(`${where}: ${what} bevat een waarde langer dan ${limits.maxLength} tekens.`);
      return null;
    }
    if (out.includes(value)) {
      if (limits.rejectDuplicates) {
        errors.push(`${where}: ${what} bevat een waarde meer dan één keer.`);
        return null;
      }
      continue;
    }
    out.push(value);
  }
  return out;
}

// Valideert de volledige lijst kenmerkdefinities (PUT-body) tegen de geldige
// typenamen van dezelfde kolomconfiguratie (kolom-typeName + aliassen) en
// tegen de al opgeslagen definities (`existing`): de soort van een bestaand
// kenmerk-id mag niet veranderen. Geeft genormaliseerde definities terug
// (strings getrimd, defaults ingevuld, options leeg bij niet-keuzelijsten)
// zodat de opgeslagen jsonb altijd exact de vorm van AttributeDef heeft. Een
// lege errors-lijst = geldig. Foutmeldingen noemen alleen positie/id/veld —
// geen interne details (DOEL-32) en geen teruggekaatste invoer buiten het
// (al op patroon gecontroleerde) id en de typenamen.
export function validateAttributeDefsInput(
  input: unknown,
  validTypeNames: string[],
  existing: AttributeDef[]
): { errors: string[]; attributes: AttributeDef[] } {
  const errors: string[] = [];
  if (!Array.isArray(input)) {
    return { errors: ['Kenmerken moeten als lijst worden aangeleverd.'], attributes: [] };
  }
  if (input.length > MAX_ATTRIBUTES) {
    return { errors: [`Maximaal ${MAX_ATTRIBUTES} kenmerken per doelenboom (nu ${input.length}).`], attributes: [] };
  }
  const validTypes = new Set(validTypeNames);
  const existingKind = new Map(existing.map((a) => [a.id, a.kind]));
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  const attributes: AttributeDef[] = [];

  input.forEach((raw, idx) => {
    if (!isPlainObject(raw)) {
      errors.push(`Kenmerk ${idx + 1}: moet een object zijn.`);
      return;
    }
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const idOk = ATTRIBUTE_ID_PATTERN.test(id);
    const where = idOk ? `Kenmerk ${idx + 1} (${id})` : `Kenmerk ${idx + 1}`;

    const unknownKeys = Object.keys(raw).filter((k) => !ALLOWED_KEYS.has(k));
    if (unknownKeys.length) {
      // Sleutelnamen zijn invoer van de client: niet letterlijk terugkaatsen.
      errors.push(`${where}: bevat ${unknownKeys.length} onbekend(e) veld(en); toegestaan zijn alleen de velden van het kenmerkschema.`);
    }

    if (!idOk) {
      errors.push(`${where}: id is verplicht en mag alleen letters, cijfers, - en _ bevatten (max. 30 tekens).`);
    } else if (seenIds.has(id)) {
      errors.push(`${where}: id "${id}" komt meer dan één keer voor.`);
    } else {
      seenIds.add(id);
    }

    const kind = raw.kind;
    if (typeof kind !== 'string' || !(ATTRIBUTE_KINDS as readonly string[]).includes(kind)) {
      errors.push(`${where}: onbekende soort; kies uit ${ATTRIBUTE_KINDS.join(', ')}.`);
      return;
    }
    const k = kind as AttributeKind;
    const previousKind = idOk ? existingKind.get(id) : undefined;
    if (previousKind && previousKind !== k) {
      errors.push(
        `${where}: de soort van een bestaand kenmerk ligt vast (${previousKind}). ` +
          'Verwijder het kenmerk en maak een nieuw kenmerk met een ander id aan.'
      );
    }

    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (typeof raw.label !== 'string' || !label) errors.push(`${where}: label is verplicht.`);
    else if (label.length > MAX_LABEL) errors.push(`${where}: label mag maximaal ${MAX_LABEL} tekens zijn.`);
    else {
      // Twee kenmerken met hetzelfde label zijn bij het invullen (DOEL-76)
      // niet uit elkaar te houden.
      const key = label.toLocaleLowerCase('nl');
      if (seenLabels.has(key)) errors.push(`${where}: dit label wordt al gebruikt door een ander kenmerk.`);
      else seenLabels.add(key);
    }

    let explanation = '';
    if (!isUnset(raw.explanation)) {
      if (typeof raw.explanation !== 'string') errors.push(`${where}: uitleg moet tekst zijn.`);
      else {
        explanation = raw.explanation.trim();
        if (explanation.length > MAX_EXPLANATION) errors.push(`${where}: uitleg mag maximaal ${MAX_EXPLANATION} tekens zijn.`);
      }
    }

    let required = false;
    if (!isUnset(raw.required)) {
      if (typeof raw.required !== 'boolean') errors.push(`${where}: required moet true of false zijn.`);
      else required = raw.required;
    }

    const subjectTypes = parseStringList(
      raw.subjectTypes, where, 'subjectTypes',
      { maxItems: MAX_TYPES_PER_LIST, maxLength: MAX_TYPE_NAME, rejectDuplicates: false }, errors
    );
    if (subjectTypes && !subjectTypes.length) {
      errors.push(`${where}: kies minstens één elementtype waarvoor het kenmerk geldt.`);
    }
    const unknownTypes = (subjectTypes ?? []).filter((t) => !validTypes.has(t));
    if (unknownTypes.length) {
      errors.push(
        `${where}: onbekend(e) elementtype(n) ${unknownTypes.map((t) => `"${t}"`).join(', ')} — ` +
          'kies uit de kolommen en aliassen van deze configuratie.'
      );
    }

    const options = parseStringList(
      raw.options, where, 'keuzelijst',
      { maxItems: MAX_OPTIONS, maxLength: MAX_OPTION, rejectDuplicates: true }, errors
    );
    if (options) {
      if (k === 'choice' && !options.length) errors.push(`${where}: een keuzelijst heeft minstens één waarde nodig.`);
      // Geweigerd (i.p.v. stil genegeerd) zodat een definitie nooit iets
      // suggereert wat niet gebruikt wordt.
      if (k !== 'choice' && options.length) errors.push(`${where}: keuzelijst is niet van toepassing op soort ${k}.`);
    }

    attributes.push({
      id, label, kind: k, subjectTypes: subjectTypes ?? [], required, explanation,
      options: k === 'choice' ? (options ?? []) : [],
    });
  });

  return { errors, attributes };
}

// Opgeslagen jsonb -> definitielijst. Defensief: alles wat geen array is wordt
// een lege lijst (sjablonen van vóór DOEL-75 hebben '[]' via de kolomdefault).
export function attributesFromDb(raw: unknown): AttributeDef[] {
  return Array.isArray(raw) ? (raw as AttributeDef[]) : [];
}

// Kenmerken die verwijzen naar een type dat (na een kolomwijziging) niet meer
// bestaat. Zelfde lijn als findRulesBrokenByColumns (controlRules.ts): zo'n
// kolomwijziging wordt GEWEIGERD met de kenmerk-id's, i.p.v. het kenmerk stil
// aan te passen — behalve voor een doelenboom van een tenant zonder actieve
// module (kenmerken zijn dan onzichtbaar; het kenmerk blijft bewaard en wordt
// bij heractivering in de editor gemarkeerd).
export function findAttributesBrokenByColumns(attributes: AttributeDef[], columns: Omit<ColumnDef, 'id'>[]): string[] {
  const valid = new Set(allValidTypeNames(columns as ColumnDef[]));
  return attributes.filter((a) => (a.subjectTypes ?? []).some((t) => !valid.has(t))).map((a) => a.id);
}

export function brokenAttributesMessage(ids: string[]): string {
  return (
    `Deze kolomwijziging zou kenmerk(en) ${ids.join(', ')} laten verwijzen naar een elementtype dat niet meer ` +
    'bestaat. Pas die kenmerk(en) eerst aan of verwijder ze (sectie Kenmerken), en sla daarna de kolommen op.'
  );
}

export async function getTenantDefaultAttributes(tenantId: number | string): Promise<AttributeDef[] | null> {
  const r = await pool.query(
    `select attributes from column_configs where scope = 'tenant_default' and tenant_id = $1`,
    [tenantId]
  );
  return r.rows[0] ? attributesFromDb(r.rows[0].attributes) : null;
}

export async function setAttributesForConfigId(client: PoolClient, configId: number, attributes: AttributeDef[]) {
  await client.query('update column_configs set attributes = $1, updated_at = now() where id = $2', [
    JSON.stringify(attributes),
    configId,
  ]);
}

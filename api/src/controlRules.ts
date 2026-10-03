import { PoolClient } from 'pg';
import { pool } from './db.js';
import { allValidTypeNames, ColumnDef } from './columnConfig.js';
import { ATTRIBUTE_ID_PATTERN, AttributeDef, AttributeKind } from './elementAttributes.js';
import { ATTRIBUTE_TEXT_MAX_LENGTH, attributeAppliesToType, isRealDate, isValidAttributeNumber } from './elementAttributeValues.js';

// Controleregels (DOEL-62, epic DOEL-61 "Module Controleregels"): per
// kolomconfiguratie (doelenboom, tenant-default of sjabloon) een lijst
// STRUCTUURregels — "is de keten gedocumenteerd sluitend", bv. "elk element
// van type Capability heeft minstens 1 ouder van type Operationele benefit".
// Opslag: column_configs.rules / doelenboom_templates.rules_snapshot (jsonb,
// zie db/migrations/0044_column_config_rules.sql). Dit bestand bevat het
// schema, de (enige, server-side) validatie en de databasetoegang.
//
// Bewust GEEN statusregels (werkt een maatregel, is er een gap): een overzicht
// van niet-werkende maatregelen is in feite een kwetsbaarhedenoverzicht en
// hoort niet in de app (epic DOEL-61, uitgangspunt 2). Daarom zijn de
// regeltypen hieronder een gesloten whitelist en worden onbekende velden
// geweigerd — er komt geen ongecontroleerde jsonb-inhoud in de database.
//
// RICHTING VAN RELATIES: een relatie (edges) loopt van source_element_id naar
// target_element_id, en in deze app is dat kind -> ouder (bv. Project ->
// Capability). Dus:
//   - requires_outgoing  = het element is de BRON  -> "heeft een OUDER van type ..."
//   - requires_incoming  = het element is het DOEL -> "heeft een KIND van type ..."
//   - primary_parent_count telt uitgaande relaties met weight = 'primair'
//     ("aantal primaire ouders").
// De evaluatie zelf volgt in DOEL-63; deze definitie is daarvoor leidend.

export const CONTROL_RULE_KINDS = [
  'requires_outgoing',
  'requires_incoming',
  'primary_parent_count',
  'requires_tag_category',
  'required_field',
  // DOEL-77: eis aan de waarde van een kenmerk (zie ATTRIBUTE_OPERATORS).
  'attribute_condition',
] as const;
export type ControlRuleKind = (typeof CONTROL_RULE_KINDS)[number];

// Whitelist van elementvelden voor required_field (kolommen van elements).
export const CONTROL_RULE_FIELDS = ['description', 'kpi', 'taakveld', 'subtaakveld'] as const;
export type ControlRuleField = (typeof CONTROL_RULE_FIELDS)[number];

export interface ControlRule {
  id: string;
  kind: ControlRuleKind;
  subjectTypes: string[];
  targetTypes: string[];
  weight: 'primair' | 'any';
  // null bij required_field (niet van toepassing); anders default 1.
  min: number | null;
  max: number | null;
  tagCategory: string | null;
  field: ControlRuleField | null;
  // Alleen bij attribute_condition (DOEL-77); anders null. Regels van vóór
  // DOEL-77 hebben deze velden niet in de opgeslagen jsonb.
  attributeId: string | null;
  operator: string | null;
  value: ControlRuleValue;
  value2: number | null;
  label: string;
  explanation: string;
  enabled: boolean;
}

export const MAX_CONTROL_RULES = 50;
export const RULE_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_LABEL = 120;
const MAX_EXPLANATION = 500;
const MAX_TAG_CATEGORY = 100;
const MAX_TYPES_PER_LIST = 50;
const MAX_COUNT = 1000;
const MAX_TYPE_NAME = 200;

const ALLOWED_KEYS = new Set([
  'id', 'kind', 'subjectTypes', 'targetTypes', 'weight', 'min', 'max',
  'tagCategory', 'field', 'label', 'explanation', 'enabled',
  'attributeId', 'operator', 'value', 'value2',
]);

const RELATION_KINDS: ReadonlySet<string> = new Set(['requires_outgoing', 'requires_incoming']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// "Niet ingevuld" voor optionele velden: afwezig of expliciet null.
function isUnset(v: unknown): boolean {
  return v === undefined || v === null;
}

// --- Kenmerkregels (DOEL-77): regeltype attribute_condition ------------------
// "Kenmerk voldoet aan…": een eis aan de waarde van een kenmerk
// (elementAttributes.ts). Net als de andere regels geformuleerd als EIS waaraan
// het element moet voldoen. Een vergelijkingsregel toetst alleen ingevulde
// waarden; een leeg kenmerk is alleen een overtreding als het kenmerk zelf
// "verplicht" is (ingebouwde regel req-<kenmerk-id>, zie
// requiredAttributeRuleId) — zo ontstaan er geen dubbele signalen. De
// evaluatie gebeurt client-side in web/public/tree.html.
//
// Per eis: bij welke soort kenmerk hij hoort ('any' = elke soort) en wat voor
// waarde erbij hoort.
type OperatorValueShape = 'none' | 'text' | 'number' | 'range' | 'date' | 'days' | 'options';
export const ATTRIBUTE_OPERATORS: Record<string, { kind: AttributeKind | 'any'; value: OperatorValueShape }> = {
  text_contains: { kind: 'text', value: 'text' },
  text_not_contains: { kind: 'text', value: 'text' },
  text_equals: { kind: 'text', value: 'text' },
  text_starts_with: { kind: 'text', value: 'text' },
  num_eq: { kind: 'number', value: 'number' },
  num_ne: { kind: 'number', value: 'number' },
  num_lt: { kind: 'number', value: 'number' },
  num_lte: { kind: 'number', value: 'number' },
  num_gt: { kind: 'number', value: 'number' },
  num_gte: { kind: 'number', value: 'number' },
  num_between: { kind: 'number', value: 'range' },
  date_before: { kind: 'date', value: 'date' },
  date_on_or_before: { kind: 'date', value: 'date' },
  date_after: { kind: 'date', value: 'date' },
  date_on_or_after: { kind: 'date', value: 'date' },
  date_max_days_old: { kind: 'date', value: 'days' },
  date_min_days_old: { kind: 'date', value: 'days' },
  date_not_in_past: { kind: 'date', value: 'none' },
  date_max_days_ahead: { kind: 'date', value: 'days' },
  choice_one_of: { kind: 'choice', value: 'options' },
  choice_none_of: { kind: 'choice', value: 'options' },
  bool_true: { kind: 'boolean', value: 'none' },
  bool_false: { kind: 'boolean', value: 'none' },
  is_empty: { kind: 'any', value: 'none' },
};
export type ControlRuleValue = string | number | string[] | null;
export const MAX_RULE_DAYS = 36500;

export interface AttributeRuleContext { attributes: AttributeDef[]; columns: ColumnDef[] }

// Ingebouwde regel voor een verplicht kenmerk. Het voorvoegsel is
// gereserveerd: een eigen regel mag er niet mee beginnen (besluit Charles
// 3 oktober 2026), zodat de sleutel (element, regel-id) van een afwijking
// nooit dubbelzinnig is.
export const REQUIRED_RULE_PREFIX = 'req-';
export function requiredAttributeRuleId(attributeId: string): string {
  return `${REQUIRED_RULE_PREFIX}${attributeId}`;
}
export function requiredAttributeRuleIds(attributes: AttributeDef[]): string[] {
  return attributes.filter((a) => a.required).map((a) => requiredAttributeRuleId(a.id));
}

// Valideert de kenmerk-velden van één regel (invoer óf een opgeslagen regel).
// Voegt foutmeldingen toe aan `errors` en geeft de genormaliseerde velden
// terug. Foutmeldingen kaatsen geen vrije invoer terug.
function parseAttributeCondition(
  raw: Record<string, unknown>,
  where: string,
  subjectTypes: string[],
  ctx: AttributeRuleContext | undefined,
  errors: string[]
): { attributeId: string | null; operator: string | null; value: ControlRuleValue; value2: number | null } {
  const none = { attributeId: null, operator: null, value: null, value2: null };
  const attributeId = typeof raw.attributeId === 'string' ? raw.attributeId.trim() : '';
  const def = ATTRIBUTE_ID_PATTERN.test(attributeId) ? ctx?.attributes.find((a) => a.id === attributeId) : undefined;
  if (!def) {
    errors.push(`${where}: kies een bestaand kenmerk voor een kenmerkregel.`);
    return none;
  }
  const notCovered = subjectTypes.filter((t) => !attributeAppliesToType(def, t, ctx!.columns));
  if (notCovered.length) {
    errors.push(`${where}: kenmerk ${def.id} geldt niet voor alle elementtypen van deze regel.`);
  }
  const operator = typeof raw.operator === 'string' ? raw.operator : '';
  const spec = Object.prototype.hasOwnProperty.call(ATTRIBUTE_OPERATORS, operator) ? ATTRIBUTE_OPERATORS[operator] : undefined;
  if (!spec) {
    errors.push(`${where}: onbekende eis voor een kenmerkregel.`);
    return none;
  }
  if (spec.kind !== 'any' && spec.kind !== def.kind) {
    errors.push(`${where}: deze eis past niet bij de soort (${def.kind}) van kenmerk ${def.id}.`);
    return none;
  }
  const v = raw.value;
  const v2 = raw.value2;
  let value: ControlRuleValue = null;
  let value2: number | null = null;
  if (spec.value !== 'range' && !isUnset(v2)) errors.push(`${where}: een tweede waarde is niet van toepassing op deze eis.`);
  switch (spec.value) {
    case 'none':
      if (!isUnset(v)) errors.push(`${where}: een waarde is niet van toepassing op deze eis.`);
      break;
    case 'text': {
      const text = typeof v === 'string' ? v.trim() : '';
      if (!text) errors.push(`${where}: vul de tekst in waarmee vergeleken wordt.`);
      else if (text.length > ATTRIBUTE_TEXT_MAX_LENGTH) errors.push(`${where}: de tekst mag maximaal ${ATTRIBUTE_TEXT_MAX_LENGTH} tekens zijn.`);
      else value = text;
      break;
    }
    case 'number':
      if (!isValidAttributeNumber(v)) errors.push(`${where}: vul een getal in (maximaal 15 cijfers, waarvan hooguit 6 achter de komma).`);
      else value = v as number;
      break;
    case 'range':
      if (!isValidAttributeNumber(v) || !isValidAttributeNumber(v2)) {
        errors.push(`${where}: vul voor "tussen" een onder- en bovengrens in (getallen).`);
      } else if ((v as number) > (v2 as number)) {
        errors.push(`${where}: de ondergrens mag niet groter zijn dan de bovengrens.`);
      } else {
        value = v as number;
        value2 = v2 as number;
      }
      break;
    case 'date':
      if (typeof v !== 'string' || !isRealDate(v.trim())) errors.push(`${where}: vul een bestaande datum in (JJJJ-MM-DD).`);
      else value = v.trim();
      break;
    case 'days':
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_RULE_DAYS) {
        errors.push(`${where}: het aantal dagen moet een geheel getal van 0 t/m ${MAX_RULE_DAYS} zijn.`);
      } else value = v;
      break;
    case 'options': {
      const options = def.options ?? [];
      const list = Array.isArray(v) ? v.map((o) => (typeof o === 'string' ? o.trim() : null)) : null;
      if (!list || !list.length || list.length > options.length || list.some((o) => o == null || !options.includes(o)) || new Set(list).size !== list.length) {
        errors.push(`${where}: kies één of meer waarden uit de keuzelijst van kenmerk ${def.id}.`);
      } else value = list as string[];
      break;
    }
  }
  return { attributeId, operator, value, value2 };
}

// Kenmerkregels die (na een wijziging van de kenmerkdefinities) niet meer
// kloppen: het kenmerk bestaat niet meer, geldt niet meer voor een type van de
// regel, of een keuzelijstwaarde uit de regel is verdwenen. Zo'n
// definitiewijziging wordt GEWEIGERD met de regel-id's (ticket DOEL-77: een
// kenmerk dat in een regel wordt gebruikt kan niet worden verwijderd; eerst
// de regel aanpassen).
export function findRulesBrokenByAttributes(rules: ControlRule[], ctx: AttributeRuleContext): string[] {
  return rules
    .filter((r) => r.kind === 'attribute_condition')
    .filter((r) => {
      const errors: string[] = [];
      parseAttributeCondition(r as unknown as Record<string, unknown>, r.id, r.subjectTypes ?? [], ctx, errors);
      return errors.length > 0;
    })
    .map((r) => r.id);
}

export function brokenRulesByAttributesMessage(ids: string[]): string {
  return (
    `Deze wijziging zou controleregel(s) ${ids.join(', ')} laten verwijzen naar een kenmerk, elementtype of ` +
    'keuzelijstwaarde die niet meer bestaat. Pas die regel(s) eerst aan of verwijder ze (sectie Controleregels), ' +
    'en sla daarna de kenmerken op.'
  );
}

function parseTypeList(
  raw: unknown,
  where: string,
  what: string,
  errors: string[]
): string[] {
  if (isUnset(raw)) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${where}: ${what} moet een lijst van typenamen zijn.`);
    return [];
  }
  if (raw.length > MAX_TYPES_PER_LIST) {
    errors.push(`${where}: ${what} mag maximaal ${MAX_TYPES_PER_LIST} typen bevatten.`);
    return [];
  }
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string' || !t.trim()) {
      errors.push(`${where}: ${what} mag alleen niet-lege typenamen bevatten.`);
      return [];
    }
    const name = t.trim();
    if (name.length > MAX_TYPE_NAME) {
      errors.push(`${where}: ${what} bevat een typenaam langer dan ${MAX_TYPE_NAME} tekens.`);
      return [];
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function parseCount(raw: unknown, where: string, what: string, errors: string[]): number | null {
  if (isUnset(raw)) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_COUNT) {
    errors.push(`${where}: ${what} moet een geheel getal van 0 t/m ${MAX_COUNT} zijn.`);
    return null;
  }
  return raw;
}

// Valideert de volledige regellijst (PUT-body) tegen de geldige typenamen van
// dezelfde kolomconfiguratie (kolom-typeName + aliassen, zie
// allValidTypeNames in columnConfig.ts). Geeft genormaliseerde regels terug
// (strings getrimd, defaults ingevuld, niet-toepasselijke velden leeg) zodat
// de opgeslagen jsonb altijd exact de vorm van ControlRule heeft. Een lege
// errors-lijst = geldig. Foutmeldingen noemen alleen positie/id/veld — geen
// interne details (DOEL-32).
export function validateControlRulesInput(
  input: unknown,
  validTypeNames: string[],
  // DOEL-77: de kenmerkdefinities en kolommen van dezelfde configuratie, voor
  // kenmerkregels. Zonder context is elke kenmerkregel ongeldig.
  attributeContext?: AttributeRuleContext
): { errors: string[]; rules: ControlRule[] } {
  const errors: string[] = [];
  if (!Array.isArray(input)) {
    return { errors: ['Controleregels moeten als lijst worden aangeleverd.'], rules: [] };
  }
  if (input.length > MAX_CONTROL_RULES) {
    return { errors: [`Maximaal ${MAX_CONTROL_RULES} controleregels per doelenboom (nu ${input.length}).`], rules: [] };
  }
  const validTypes = new Set(validTypeNames);
  const seenIds = new Set<string>();
  const rules: ControlRule[] = [];

  input.forEach((raw, idx) => {
    if (!isPlainObject(raw)) {
      errors.push(`Regel ${idx + 1}: moet een object zijn.`);
      return;
    }
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const where = id && RULE_ID_PATTERN.test(id) ? `Regel ${idx + 1} (${id})` : `Regel ${idx + 1}`;
    const before = errors.length;

    const unknownKeys = Object.keys(raw).filter((k) => !ALLOWED_KEYS.has(k));
    if (unknownKeys.length) {
      // Sleutelnamen zijn invoer van de client: niet letterlijk terugkaatsen,
      // alleen het aantal noemen.
      errors.push(`${where}: bevat ${unknownKeys.length} onbekend(e) veld(en); toegestaan zijn alleen de velden van het regelschema.`);
    }

    if (!RULE_ID_PATTERN.test(id)) {
      errors.push(`${where}: id is verplicht en mag alleen letters, cijfers, - en _ bevatten (max. 40 tekens).`);
    } else if (id.toLowerCase().startsWith(REQUIRED_RULE_PREFIX)) {
      errors.push(`${where}: een id mag niet met "${REQUIRED_RULE_PREFIX}" beginnen; dat is gereserveerd voor verplichte kenmerken.`);
    } else if (seenIds.has(id)) {
      errors.push(`${where}: id "${id}" komt meer dan één keer voor.`);
    } else {
      seenIds.add(id);
    }

    const kind = raw.kind;
    if (typeof kind !== 'string' || !(CONTROL_RULE_KINDS as readonly string[]).includes(kind)) {
      errors.push(`${where}: onbekend regeltype; kies uit ${CONTROL_RULE_KINDS.join(', ')}.`);
      return;
    }
    const k = kind as ControlRuleKind;

    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (typeof raw.label !== 'string' || !label) errors.push(`${where}: label is verplicht.`);
    else if (label.length > MAX_LABEL) errors.push(`${where}: label mag maximaal ${MAX_LABEL} tekens zijn.`);

    let explanation = '';
    if (!isUnset(raw.explanation)) {
      if (typeof raw.explanation !== 'string') errors.push(`${where}: uitleg moet tekst zijn.`);
      else {
        explanation = raw.explanation.trim();
        if (explanation.length > MAX_EXPLANATION) errors.push(`${where}: uitleg mag maximaal ${MAX_EXPLANATION} tekens zijn.`);
      }
    }

    let enabled = true;
    if (!isUnset(raw.enabled)) {
      if (typeof raw.enabled !== 'boolean') errors.push(`${where}: enabled moet true of false zijn.`);
      else enabled = raw.enabled;
    }

    const subjectTypes = parseTypeList(raw.subjectTypes, where, 'subjectTypes', errors);
    if (!subjectTypes.length && !errors.slice(before).some((e) => e.includes('subjectTypes'))) {
      errors.push(`${where}: kies minstens één elementtype waarop de regel van toepassing is.`);
    }
    const targetTypes = parseTypeList(raw.targetTypes, where, 'targetTypes', errors);

    let weight: 'primair' | 'any' = 'any';
    if (!isUnset(raw.weight)) {
      if (raw.weight !== 'primair' && raw.weight !== 'any') errors.push(`${where}: weight moet "primair" of "any" zijn.`);
      else weight = raw.weight;
    }

    const minRaw = parseCount(raw.min, where, 'min', errors);
    const maxRaw = parseCount(raw.max, where, 'max', errors);

    let tagCategory: string | null = null;
    if (!isUnset(raw.tagCategory)) {
      if (typeof raw.tagCategory !== 'string') errors.push(`${where}: tagCategory moet tekst zijn.`);
      else {
        tagCategory = raw.tagCategory.trim() || null;
        if (tagCategory && tagCategory.length > MAX_TAG_CATEGORY) {
          errors.push(`${where}: tagCategory mag maximaal ${MAX_TAG_CATEGORY} tekens zijn.`);
        }
      }
    }

    let field: ControlRuleField | null = null;
    if (!isUnset(raw.field)) {
      if (typeof raw.field !== 'string' || !(CONTROL_RULE_FIELDS as readonly string[]).includes(raw.field)) {
        errors.push(`${where}: veld moet een van ${CONTROL_RULE_FIELDS.join(', ')} zijn.`);
      } else field = raw.field as ControlRuleField;
    }

    // Verplichte en niet-toepasselijke velden per regeltype. Niet-toepasselijke
    // velden worden geweigerd (i.p.v. stil genegeerd) zodat een regel nooit
    // iets suggereert wat niet gecontroleerd wordt.
    const notApplicable = (name: string, set: boolean) => {
      if (set) errors.push(`${where}: ${name} is niet van toepassing op regeltype ${k}.`);
    };
    const isRelation = RELATION_KINDS.has(k);
    if (isRelation) {
      if (!targetTypes.length && !errors.slice(before).some((e) => e.includes('targetTypes'))) {
        errors.push(`${where}: kies minstens één doeltype (targetTypes) voor een relatieregel.`);
      }
    } else {
      notApplicable('targetTypes', targetTypes.length > 0);
      // 'any' is de (genormaliseerde) default en dus geen inhoudelijke keuze.
      notApplicable('weight', !isUnset(raw.weight) && raw.weight !== 'any');
    }
    if (k !== 'requires_tag_category') notApplicable('tagCategory', tagCategory != null);
    else if (!tagCategory && !errors.slice(before).some((e) => e.includes('tagCategory'))) {
      errors.push(`${where}: tagCategory is verplicht voor een tagregel.`);
    }
    if (k !== 'required_field') notApplicable('field', field != null);
    else if (!field && isUnset(raw.field)) errors.push(`${where}: kies het verplichte veld.`);
    const noCount = k === 'required_field' || k === 'attribute_condition';
    if (noCount) {
      notApplicable('min', minRaw != null);
      notApplicable('max', maxRaw != null);
    }
    if (k === 'requires_tag_category') notApplicable('max', maxRaw != null);

    // DOEL-77: kenmerk-velden alleen bij een kenmerkregel.
    let condition: ReturnType<typeof parseAttributeCondition> = { attributeId: null, operator: null, value: null, value2: null };
    if (k === 'attribute_condition') {
      condition = parseAttributeCondition(raw, where, subjectTypes, attributeContext, errors);
    } else {
      notApplicable('attributeId', !isUnset(raw.attributeId));
      notApplicable('operator', !isUnset(raw.operator));
      notApplicable('value', !isUnset(raw.value));
      notApplicable('value2', !isUnset(raw.value2));
    }

    const min = noCount ? null : (minRaw ?? 1);
    const max = noCount || k === 'requires_tag_category' ? null : maxRaw;
    if (max != null && min != null && min > max) errors.push(`${where}: min (${min}) mag niet groter zijn dan max (${max}).`);

    const unknownTypes = [...subjectTypes, ...targetTypes].filter((t) => !validTypes.has(t));
    if (unknownTypes.length) {
      errors.push(
        `${where}: onbekend(e) elementtype(n) ${unknownTypes.map((t) => `"${t}"`).join(', ')} — ` +
          'kies uit de kolommen en aliassen van deze configuratie.'
      );
    }

    rules.push({
      id, kind: k, subjectTypes, targetTypes: isRelation ? targetTypes : [],
      weight: isRelation ? weight : 'any', min, max,
      tagCategory: k === 'requires_tag_category' ? tagCategory : null,
      field: k === 'required_field' ? field : null,
      attributeId: condition.attributeId, operator: condition.operator, value: condition.value, value2: condition.value2,
      label, explanation, enabled,
    });
  });

  return { errors, rules };
}

// Opgeslagen jsonb -> regellijst. Defensief: alles wat geen array is wordt een
// lege lijst (oude sjablonen zonder rules_snapshot leveren '[]' via de
// kolomdefault, maar een snapshot-JSON van vóór de migratie kan ontbreken).
export function rulesFromDb(raw: unknown): ControlRule[] {
  return Array.isArray(raw) ? (raw as ControlRule[]) : [];
}

// Regels die verwijzen naar een type dat (na een kolomwijziging) niet meer
// bestaat. Gebruikt bij elke kolom-PUT: zo'n wijziging wordt GEWEIGERD met de
// regel-id's in de foutmelding, i.p.v. de regel stil te verwijderen of aan te
// passen (ticket DOEL-62: een regel-id is een stabiele sleutel waar in DOEL-64
// afwijkingen aan hangen — de gebruiker moet bewust kiezen wat ermee gebeurt).
// Uitzondering (besluit Charles, zie DOEL-62): voor een doelenboom van een
// tenant ZONDER actieve module 'controleregels' gaat de kolomwijziging wel
// door (de regels zijn dan onzichtbaar, de klant zou een blokkade niet kunnen
// oplossen); de regel blijft bewaard en wordt bij heractivering in de editor
// als "verwijst naar onbekend type" gemarkeerd — opslaan kan pas weer als hij
// is hersteld (validateControlRulesInput weigert onbekende typen).
export function findRulesBrokenByColumns(rules: ControlRule[], columns: Omit<ColumnDef, 'id'>[]): string[] {
  const valid = new Set(allValidTypeNames(columns as ColumnDef[]));
  return rules
    .filter((r) => [...(r.subjectTypes ?? []), ...(r.targetTypes ?? [])].some((t) => !valid.has(t)))
    .map((r) => r.id);
}

export function brokenRulesMessage(ids: string[]): string {
  return (
    `Deze kolomwijziging zou controleregel(s) ${ids.join(', ')} laten verwijzen naar een elementtype dat niet meer ` +
    'bestaat. Pas die regel(s) eerst aan of verwijder ze (sectie Controleregels), en sla daarna de kolommen op.'
  );
}

export const CONTROLE_REGELS_MODULE = 'controleregels';

export async function getRulesForDoelenboom(doelenboomId: number | string): Promise<ControlRule[] | null> {
  const r = await pool.query(
    `select rules from column_configs where scope = 'doelenboom' and doelenboom_id = $1`,
    [doelenboomId]
  );
  return r.rows[0] ? rulesFromDb(r.rows[0].rules) : null;
}

export async function getTenantDefaultRules(tenantId: number | string): Promise<ControlRule[] | null> {
  const r = await pool.query(
    `select rules from column_configs where scope = 'tenant_default' and tenant_id = $1`,
    [tenantId]
  );
  return r.rows[0] ? rulesFromDb(r.rows[0].rules) : null;
}

export async function getRulesForConfigId(client: PoolClient, configId: number): Promise<ControlRule[]> {
  const r = await client.query('select rules from column_configs where id = $1', [configId]);
  return rulesFromDb(r.rows[0]?.rules);
}

export async function setRulesForConfigId(client: PoolClient, configId: number, rules: ControlRule[]) {
  await client.query('update column_configs set rules = $1, updated_at = now() where id = $2', [
    JSON.stringify(rules),
    configId,
  ]);
}

// Bestaande tag-categorieën van een doelenboom (voor de keuzelijst in de
// beheer-UI). Alleen de categorienamen, geen tags zelf.
export async function getTagCategoriesForDoelenboom(doelenboomId: number | string): Promise<string[]> {
  const r = await pool.query(
    `select distinct categorie from tags where doelenboom_id = $1 and categorie <> '' order by categorie`,
    [doelenboomId]
  );
  return r.rows.map((row) => row.categorie as string);
}

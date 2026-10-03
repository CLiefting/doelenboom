import { useEffect, useState } from 'react';
import { ApiError } from '../api';
import type { AttributeDef, AttributeKind, ControlRule, ControlRuleField, ControlRuleKind, ControlRulesState } from '../types';

// Beheer van controleregels (DOEL-62, epic DOEL-61) — sectie onder de kolommen
// in <ColumnConfigEditor>, voor de drie soorten config (tenant-default,
// doelenboom, sjabloon). De server (api/src/controlRules.ts) valideert alles en
// is de echte grens; hier alleen snelle feedback en een leesbare samenvatting.
//
// Alle door gebruikers ingevoerde tekst (labels, uitleg, typenamen) wordt als
// gewone React-tekst gerenderd — dus altijd ge-escaped; geen
// dangerouslySetInnerHTML, geen inline handlers in HTML-strings.
//
// Richting van relaties: bron -> doel = kind -> ouder (bv. Project ->
// Capability). "Uitgaand" = "heeft een OUDER van type…", "inkomend" = "heeft
// een KIND van type…" — zo staat het ook in de keuzelijst en samenvatting.

export const KIND_LABELS: Record<ControlRuleKind, string> = {
  requires_outgoing: 'Heeft ouder van type… (uitgaande relatie)',
  requires_incoming: 'Heeft kind van type… (inkomende relatie)',
  primary_parent_count: 'Aantal primaire ouders',
  requires_tag_category: 'Heeft tag in categorie…',
  required_field: 'Veld is ingevuld',
  attribute_condition: 'Kenmerk voldoet aan…',
};

export const FIELD_LABELS: Record<ControlRuleField, string> = {
  description: 'Omschrijving',
  kpi: 'KPI',
  taakveld: 'Taakveld',
  subtaakveld: 'Subtaakveld',
};

const KINDS = Object.keys(KIND_LABELS) as ControlRuleKind[];
const FIELDS = Object.keys(FIELD_LABELS) as ControlRuleField[];
const RELATION_KINDS: ControlRuleKind[] = ['requires_outgoing', 'requires_incoming'];

// Kenmerkregels (DOEL-77): de eisen per soort kenmerk, met het soort waarde
// dat erbij hoort. Zelfde lijst als ATTRIBUTE_OPERATORS in
// api/src/controlRules.ts; de formulering van de eis is dezelfde als in
// attributeRequirementText (web/public/tree.html).
type ValueShape = 'none' | 'text' | 'number' | 'range' | 'date' | 'days' | 'options';
export const ATTRIBUTE_OPERATORS: Array<{ op: string; kind: AttributeKind | 'any'; shape: ValueShape; label: string }> = [
  { op: 'text_contains', kind: 'text', shape: 'text', label: 'bevat' },
  { op: 'text_not_contains', kind: 'text', shape: 'text', label: 'bevat niet' },
  { op: 'text_equals', kind: 'text', shape: 'text', label: 'is gelijk aan' },
  { op: 'text_starts_with', kind: 'text', shape: 'text', label: 'begint met' },
  { op: 'num_eq', kind: 'number', shape: 'number', label: 'is gelijk aan' },
  { op: 'num_ne', kind: 'number', shape: 'number', label: 'is niet gelijk aan' },
  { op: 'num_lt', kind: 'number', shape: 'number', label: 'is kleiner dan' },
  { op: 'num_lte', kind: 'number', shape: 'number', label: 'is hooguit' },
  { op: 'num_gt', kind: 'number', shape: 'number', label: 'is groter dan' },
  { op: 'num_gte', kind: 'number', shape: 'number', label: 'is minstens' },
  { op: 'num_between', kind: 'number', shape: 'range', label: 'ligt tussen' },
  { op: 'date_before', kind: 'date', shape: 'date', label: 'ligt vóór datum' },
  { op: 'date_on_or_before', kind: 'date', shape: 'date', label: 'ligt op of vóór datum' },
  { op: 'date_after', kind: 'date', shape: 'date', label: 'ligt na datum' },
  { op: 'date_on_or_after', kind: 'date', shape: 'date', label: 'ligt op of na datum' },
  { op: 'date_max_days_old', kind: 'date', shape: 'days', label: 'is hooguit N dagen oud' },
  { op: 'date_min_days_old', kind: 'date', shape: 'days', label: 'is minstens N dagen oud' },
  { op: 'date_not_in_past', kind: 'date', shape: 'none', label: 'ligt niet in het verleden' },
  { op: 'date_max_days_ahead', kind: 'date', shape: 'days', label: 'ligt hooguit N dagen in de toekomst' },
  { op: 'choice_one_of', kind: 'choice', shape: 'options', label: 'is een van' },
  { op: 'choice_none_of', kind: 'choice', shape: 'options', label: 'is geen van' },
  { op: 'bool_true', kind: 'boolean', shape: 'none', label: 'is ja' },
  { op: 'bool_false', kind: 'boolean', shape: 'none', label: 'is nee' },
  { op: 'is_empty', kind: 'any', shape: 'none', label: 'is leeg' },
];
const operatorSpec = (op: string | null | undefined) => ATTRIBUTE_OPERATORS.find((o) => o.op === op);

const nlNumber = (v: unknown) => String(v ?? '…').replace('.', ',');
function nlDate(v: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '…';
}
const nlDays = (v: unknown) => (typeof v === 'number' ? `${v} ${v === 1 ? 'dag' : 'dagen'}` : '… dagen');

// De eis als leesbare tekst, bv. "is hooguit 180 dagen oud".
export function requirementText(r: ControlRule): string {
  const v = r.value;
  switch (r.operator) {
    case 'text_contains': return `bevat "${v ?? '…'}"`;
    case 'text_not_contains': return `bevat niet "${v ?? '…'}"`;
    case 'text_equals': return `is gelijk aan "${v ?? '…'}"`;
    case 'text_starts_with': return `begint met "${v ?? '…'}"`;
    case 'num_eq': return `is gelijk aan ${nlNumber(v)}`;
    case 'num_ne': return `is niet gelijk aan ${nlNumber(v)}`;
    case 'num_lt': return `is kleiner dan ${nlNumber(v)}`;
    case 'num_lte': return `is hooguit ${nlNumber(v)}`;
    case 'num_gt': return `is groter dan ${nlNumber(v)}`;
    case 'num_gte': return `is minstens ${nlNumber(v)}`;
    case 'num_between': return `ligt tussen ${nlNumber(v)} en ${nlNumber(r.value2)}`;
    case 'date_before': return `ligt vóór ${nlDate(v)}`;
    case 'date_on_or_before': return `ligt op of vóór ${nlDate(v)}`;
    case 'date_after': return `ligt na ${nlDate(v)}`;
    case 'date_on_or_after': return `ligt op of na ${nlDate(v)}`;
    case 'date_max_days_old': return `is hooguit ${nlDays(v)} oud`;
    case 'date_min_days_old': return `is minstens ${nlDays(v)} oud`;
    case 'date_not_in_past': return 'ligt niet in het verleden';
    case 'date_max_days_ahead': return `ligt hooguit ${nlDays(v)} in de toekomst`;
    case 'choice_one_of': return `is een van: ${Array.isArray(v) && v.length ? v.join(', ') : '…'}`;
    case 'choice_none_of': return `is geen van: ${Array.isArray(v) && v.length ? v.join(', ') : '…'}`;
    case 'bool_true': return 'is ja';
    case 'bool_false': return 'is nee';
    case 'is_empty': return 'is leeg';
    default: return '…';
  }
}

function typeList(types: string[]): string {
  if (types.length === 0) return '…';
  if (types.length === 1) return types[0];
  return `${types.slice(0, -1).join(', ')} of ${types[types.length - 1]}`;
}

// Leesbare samenvatting, bv. "Elk element van type Control heeft minstens 1
// ouder van type Capability." Geëxporteerd voor hergebruik in DOEL-63.
export function summarizeRule(r: ControlRule, attributes: AttributeDef[] = []): string {
  const subject = `Elk element van type ${typeList(r.subjectTypes)}`;
  const min = r.min ?? 1;
  const range = (noun: string, plural: string) => {
    const n = (k: number) => `${k} ${k === 1 ? noun : plural}`;
    if (r.max != null && r.max === min) return `precies ${n(min)}`;
    if (r.max != null) return `minstens ${min} en hoogstens ${n(r.max)}`;
    return `minstens ${n(min)}`;
  };
  const prim = r.weight === 'primair' ? 'primaire ' : '';
  switch (r.kind) {
    case 'requires_outgoing':
      return `${subject} heeft ${range(`${prim}ouder`, `${prim}ouders`)} van type ${typeList(r.targetTypes)}.`;
    case 'requires_incoming':
      return `${subject} heeft ${range(`${prim}kind`, `${prim}kinderen`)} van type ${typeList(r.targetTypes)}.`;
    case 'primary_parent_count':
      return `${subject} heeft ${range('primaire ouder', 'primaire ouders')}.`;
    case 'requires_tag_category':
      return `${subject} heeft ${range('tag', 'tags')} in categorie "${r.tagCategory ?? '…'}".`;
    case 'required_field':
      return `${subject} heeft een ingevuld veld "${r.field ? FIELD_LABELS[r.field] : '…'}".`;
    case 'attribute_condition': {
      const label = attributes.find((a) => a.id === r.attributeId)?.label ?? r.attributeId ?? '…';
      const note = r.operator === 'is_empty' ? '' : ' Lege waarden worden niet getoetst.';
      return `Bij elk element van type ${typeList(r.subjectTypes)} geldt: kenmerk "${label}" ${requirementText(r)}.${note}`;
    }
  }
}

function nextRuleId(rules: ControlRule[]): string {
  let n = rules.length + 1;
  const ids = new Set(rules.map((r) => r.id));
  while (ids.has(`R${String(n).padStart(2, '0')}`)) n += 1;
  return `R${String(n).padStart(2, '0')}`;
}

function emptyRule(id: string): ControlRule {
  return {
    id, kind: 'requires_outgoing', subjectTypes: [], targetTypes: [], weight: 'any',
    min: 1, max: null, tagCategory: null, field: null, attributeId: null, operator: null, value: null, value2: null,
    label: '', explanation: '', enabled: true,
  };
}

// Brengt een regel in de vorm die de server voor dit regeltype accepteert
// (niet-toepasselijke velden leeg) — zelfde normalisatie als de server.
function normalize(r: ControlRule): ControlRule {
  const isRelation = RELATION_KINDS.includes(r.kind);
  const isAttribute = r.kind === 'attribute_condition';
  const shape = isAttribute ? operatorSpec(r.operator)?.shape : undefined;
  const noCount = r.kind === 'required_field' || isAttribute;
  let value: ControlRule['value'] = null;
  if (shape === 'text') value = typeof r.value === 'string' ? r.value.trim() : null;
  else if (shape === 'date') value = typeof r.value === 'string' && r.value ? r.value : null;
  else if (shape === 'number' || shape === 'range' || shape === 'days') value = typeof r.value === 'number' ? r.value : null;
  else if (shape === 'options') value = Array.isArray(r.value) ? r.value : [];
  return {
    ...r,
    id: r.id.trim(),
    label: r.label.trim(),
    explanation: r.explanation.trim(),
    targetTypes: isRelation ? r.targetTypes : [],
    weight: isRelation ? r.weight : 'any',
    min: noCount ? null : (r.min ?? 1),
    max: noCount || r.kind === 'requires_tag_category' ? null : r.max,
    tagCategory: r.kind === 'requires_tag_category' ? (r.tagCategory?.trim() || null) : null,
    field: r.kind === 'required_field' ? r.field : null,
    attributeId: isAttribute ? (r.attributeId ?? null) : null,
    operator: isAttribute ? (r.operator ?? null) : null,
    value,
    value2: shape === 'range' && typeof r.value2 === 'number' ? r.value2 : null,
  };
}

function validateRule(r: ControlRule, others: ControlRule[], validTypes: Set<string>, attributes: AttributeDef[]): string | null {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(r.id)) return 'Id: alleen letters, cijfers, - en _ (max. 40 tekens).';
  if (/^req-/i.test(r.id)) return 'Een id mag niet met "req-" beginnen; dat is gereserveerd voor verplichte kenmerken.';
  if (others.some((o) => o.id === r.id)) return `Id "${r.id}" bestaat al.`;
  if (!r.label) return 'Label is verplicht.';
  if (r.label.length > 120) return 'Label mag maximaal 120 tekens zijn.';
  if (r.explanation.length > 500) return 'Uitleg mag maximaal 500 tekens zijn.';
  if (r.subjectTypes.length === 0) return 'Kies minstens één elementtype waarop de regel van toepassing is.';
  if (RELATION_KINDS.includes(r.kind) && r.targetTypes.length === 0) return 'Kies minstens één type voor de relatie.';
  if (r.kind === 'requires_tag_category' && !r.tagCategory) return 'Kies of typ een tag-categorie.';
  if (r.kind === 'required_field' && !r.field) return 'Kies het verplichte veld.';
  if (r.kind === 'attribute_condition') {
    const def = attributes.find((a) => a.id === r.attributeId);
    if (!def) return 'Kies het kenmerk.';
    const spec = operatorSpec(r.operator);
    if (!spec || (spec.kind !== 'any' && spec.kind !== def.kind)) return 'Kies de eis.';
    if (spec.shape === 'text' && !r.value) return 'Vul de tekst in waarmee vergeleken wordt.';
    if (spec.shape === 'text' && String(r.value).length > 200) return 'De tekst mag maximaal 200 tekens zijn.';
    if (spec.shape === 'number' && typeof r.value !== 'number') return 'Vul een getal in.';
    if (spec.shape === 'range' && (typeof r.value !== 'number' || typeof r.value2 !== 'number')) return 'Vul een onder- en bovengrens in.';
    if (spec.shape === 'range' && (r.value as number) > (r.value2 as number)) return 'De ondergrens mag niet groter zijn dan de bovengrens.';
    if (spec.shape === 'date' && !r.value) return 'Kies een datum.';
    if (spec.shape === 'days' && (typeof r.value !== 'number' || !Number.isInteger(r.value) || r.value < 0 || r.value > 36500)) {
      return 'Vul een aantal dagen in (geheel getal van 0 t/m 36500).';
    }
    if (spec.shape === 'options' && (!Array.isArray(r.value) || r.value.length === 0)) return 'Kies minstens één waarde uit de keuzelijst.';
  }
  if (r.min != null && r.max != null && r.min > r.max) return 'Min mag niet groter zijn dan max.';
  const unknown = [...r.subjectTypes, ...r.targetTypes].filter((t) => !validTypes.has(t));
  if (unknown.length) return `Onbekend(e) type(n): ${unknown.join(', ')}.`;
  return null;
}

export default function ControlRulesEditor({
  load,
  save,
  hideWhenModuleInactive,
}: {
  load: () => Promise<ControlRulesState>;
  save: (rules: ControlRule[]) => Promise<{ rules: ControlRule[]; invalidRuleIds: string[] }>;
  // true voor de regels van één doelenboom: zonder actieve module wordt de
  // sectie volledig verborgen (zichtbaarheidsprincipe, licentiemodel §3).
  // Tenant-default en sjablonen tonen de sectie altijd (configuratie voor
  // nieuwe bomen), met een melding als de module niet actief is.
  hideWhenModuleInactive: boolean;
}) {
  const [state, setState] = useState<ControlRulesState | null>(null);
  const [rules, setRules] = useState<ControlRule[]>([]);
  const [editing, setEditing] = useState<{ index: number | null; draft: ControlRule } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    load()
      .then((s) => {
        setState(s);
        setRules(s.rules);
      })
      .catch((err) => setError(errMsg(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!state) return error ? <p style={styles.error}>{error}</p> : null;
  if (hideWhenModuleInactive && !state.moduleActive) return null;

  const validTypes = new Set(state.validTypeNames);
  const attributes = state.attributes ?? [];
  // Ongeldig: een onbekend type, of (DOEL-77, door de server gemeld) een
  // kenmerkregel waarvan het kenmerk of een keuzelijstwaarde niet meer bestaat.
  const isInvalid = (r: ControlRule) =>
    [...r.subjectTypes, ...r.targetTypes].some((t) => !validTypes.has(t)) ||
    (r.kind === 'attribute_condition' && !attributes.some((a) => a.id === r.attributeId)) ||
    (!dirty && state.invalidRuleIds.includes(r.id));

  function change(next: ControlRule[]) {
    setRules(next);
    setDirty(true);
    setSaved(false);
  }

  function startAdd() {
    setFormError(null);
    setEditing({ index: null, draft: emptyRule(nextRuleId(rules)) });
  }

  function startEdit(index: number) {
    setFormError(null);
    setEditing({ index, draft: { ...rules[index] } });
  }

  function applyDraft() {
    if (!editing) return;
    const draft = normalize(editing.draft);
    const others = rules.filter((_, i) => i !== editing.index);
    const problem = validateRule(draft, others, validTypes, attributes);
    if (problem) {
      setFormError(problem);
      return;
    }
    const next = editing.index == null ? [...rules, draft] : rules.map((r, i) => (i === editing.index ? draft : r));
    change(next);
    setEditing(null);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await save(rules.map(normalize));
      setRules(result.rules);
      // Na opslaan zijn de motivaties van verwijderde regels opgeruimd (DOEL-64).
      const kept = new Set(result.rules.map((r) => r.id));
      const deviationCounts = Object.fromEntries(Object.entries(state!.deviationCounts ?? {}).filter(([id]) => kept.has(id)));
      setState({ ...state!, rules: result.rules, invalidRuleIds: result.invalidRuleIds, deviationCounts });
      setDirty(false);
      setSaved(true);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  // DOEL-64: motivaties van afwijkingen horen bij een regel-id; verdwijnt de
  // regel uit de lijst, dan ruimt de server ze bij het opslaan op.
  const currentIds = new Set(rules.map((r) => r.id));
  const lostRuleIds = Object.keys(state.deviationCounts ?? {}).filter((id) => !currentIds.has(id) && state.deviationCounts![id] > 0);
  const lostDeviations = lostRuleIds.reduce((sum, id) => sum + state.deviationCounts![id], 0);

  return (
    <section style={styles.section} aria-label="Controleregels">
      <h3 style={styles.h3}>Controleregels</h3>
      <p style={styles.hint}>
        Regels die controleren of de keten <em>gedocumenteerd</em> sluitend is (ontbrekende schakels) — niet of iets
        werkt. <strong>Leg alleen structuur vast; geen inhoudelijke of gerubriceerde informatie.</strong> Een
        kenmerkregel toetst een kenmerk (metagegevens) aan een eis; een verplicht kenmerk is zonder regel al een
        signaal.
      </p>
      <p style={styles.muted}>
        Een relatie loopt van kind naar ouder (bv. Project → Capability): "ouder van type…" is een uitgaande relatie,
        "kind van type…" een inkomende. De keuzelijsten tonen de <em>opgeslagen</em> kolommen en aliassen — sla
        gewijzigde kolommen eerst op.
      </p>
      {!state.moduleActive && (
        <p style={styles.warn}>
          De module Controleregels is niet actief voor deze tenant: regels worden wel bewaard, maar pas gebruikt in een
          tenant met deze module.
        </p>
      )}
      {error && <p style={styles.error}>{error}</p>}

      {rules.length === 0 && <p style={styles.muted}>Nog geen controleregels.</p>}
      {lostDeviations > 0 && (
        <p style={styles.warn} role="alert">
          Let op: bij opslaan {lostDeviations === 1 ? 'vervalt 1 motivatie' : `vervallen ${lostDeviations} motivaties`} van
          afwijkingen bij de verwijderde regel{lostRuleIds.length === 1 ? '' : 's'} {lostRuleIds.join(', ')}. Dit kan niet
          ongedaan worden gemaakt. Wil je de motivaties bewaren, zet de regel dan uit in plaats van hem te verwijderen.
        </p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rules.map((r, i) => (
          <div key={r.id} style={{ ...styles.ruleRow, opacity: r.enabled ? 1 : 0.6 }}>
            <label style={styles.checkLabel} title="Regel aan/uit (uit = tijdelijk niet gecontroleerd, niet verwijderd)">
              <input
                type="checkbox" checked={r.enabled} disabled={busy}
                onChange={(e) => change(rules.map((x, xi) => (xi === i ? { ...x, enabled: e.target.checked } : x)))}
              />
            </label>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>
                <code style={styles.code}>{r.id}</code> <strong>{r.label}</strong>
                {!r.enabled && <span style={styles.badge}>uit</span>}
                {(state.deviationCounts?.[r.id] ?? 0) > 0 && (
                  <span style={styles.badge} title="Aantal elementen waarvoor een afwijking van deze regel is gemotiveerd. Verwijderen van de regel wist deze motivaties.">
                    {state.deviationCounts![r.id]} gemotiveerd
                  </span>
                )}
                {isInvalid(r) && (
                  <span style={styles.badgeError} title="Deze regel verwijst naar een elementtype, kenmerk of keuzelijstwaarde die niet (meer) bestaat; pas hem aan of verwijder hem.">
                    verwijst naar onbekend type of kenmerk
                  </span>
                )}
              </div>
              <div style={styles.summary}>{summarizeRule(r, attributes)}</div>
              {r.explanation && <div style={styles.explanation}>{r.explanation}</div>}
            </div>
            <button type="button" disabled={busy} onClick={() => startEdit(i)} style={styles.linkBtn}>Bewerken</button>
            <button type="button" disabled={busy} onClick={() => change(rules.filter((_, xi) => xi !== i))} style={styles.removeBtn}>
              Verwijderen
            </button>
          </div>
        ))}
      </div>

      {editing && (
        <RuleForm
          draft={editing.draft}
          isNew={editing.index == null}
          typeNames={state.validTypeNames}
          tagCategories={state.tagCategories}
          attributes={attributes}
          error={formError}
          onChange={(draft) => setEditing({ ...editing, draft })}
          onApply={applyDraft}
          onCancel={() => setEditing(null)}
        />
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
        {!editing && (
          <button type="button" disabled={busy || rules.length >= 50} onClick={startAdd} style={styles.ghostBtn}>
            + Regel toevoegen
          </button>
        )}
        <button type="button" disabled={busy || !dirty || !!editing} onClick={submit} style={styles.primaryBtn}>
          Controleregels opslaan
        </button>
        {dirty && !saved && <span style={styles.muted}>Niet opgeslagen wijzigingen.</span>}
        {saved && <span style={{ color: '#2e7d32', fontSize: 12.5 }}>Opgeslagen.</span>}
      </div>
    </section>
  );
}

function TypeChecklist({
  label, all, selected, onChange,
}: { label: string; all: string[]; selected: string[]; onChange: (next: string[]) => void }) {
  return (
    <fieldset style={styles.fieldset}>
      <legend style={styles.legend}>{label}</legend>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
        {all.map((t) => (
          <label key={t} style={styles.checkLabel}>
            <input
              type="checkbox" checked={selected.includes(t)}
              onChange={(e) => onChange(e.target.checked ? [...selected, t] : selected.filter((x) => x !== t))}
            />
            {t}
          </label>
        ))}
        {/* Typen in de regel die niet (meer) bestaan — zichtbaar zodat ze uitgevinkt kunnen worden. */}
        {selected.filter((t) => !all.includes(t)).map((t) => (
          <label key={`x-${t}`} style={{ ...styles.checkLabel, color: '#DC3545' }}>
            <input type="checkbox" checked onChange={() => onChange(selected.filter((x) => x !== t))} />
            {t} (bestaat niet meer)
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function RuleForm({
  draft, isNew, typeNames, tagCategories, attributes, error, onChange, onApply, onCancel,
}: {
  draft: ControlRule;
  isNew: boolean;
  typeNames: string[];
  tagCategories: string[];
  attributes: AttributeDef[];
  error: string | null;
  onChange: (d: ControlRule) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<ControlRule>) => onChange({ ...draft, ...patch });
  const isRelation = RELATION_KINDS.includes(draft.kind);
  const numOrNull = (v: string) => (v === '' ? null : Math.max(0, Math.floor(Number(v))));
  const relNoun = draft.kind === 'requires_incoming' ? 'kind' : 'ouder';
  // Kenmerkregel (DOEL-77): het gekozen kenmerk bepaalt welke eisen passen.
  const isAttribute = draft.kind === 'attribute_condition';
  const attribute = attributes.find((a) => a.id === draft.attributeId);
  const operators = attribute ? ATTRIBUTE_OPERATORS.filter((o) => o.kind === 'any' || o.kind === attribute.kind) : [];
  const shape = operatorSpec(draft.operator)?.shape;
  const numberOrNull = (v: string) => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const selectedOptions = Array.isArray(draft.value) ? draft.value : [];

  return (
    <div style={styles.form}>
      {error && <p style={styles.error}>{error}</p>}
      <div style={styles.formRow}>
        <label style={styles.fieldLabel}>
          Id
          <input
            style={{ ...styles.input, width: 110 }} value={draft.id} disabled={!isNew} maxLength={40}
            title="Stabiele sleutel van de regel; na opslaan niet meer te wijzigen en nooit hergebruiken voor een andere betekenis."
            onChange={(e) => set({ id: e.target.value })}
          />
        </label>
        <label style={styles.fieldLabel}>
          Regeltype
          <select style={styles.input} value={draft.kind} onChange={(e) => set({ kind: e.target.value as ControlRuleKind })}>
            {KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
          </select>
        </label>
        <label style={{ ...styles.fieldLabel, flex: '1 1 240px' }}>
          Label
          <input
            style={styles.input} value={draft.label} maxLength={120} placeholder="Korte naam van de regel"
            onChange={(e) => set({ label: e.target.value })}
          />
        </label>
      </div>

      <TypeChecklist
        label="Geldt voor elementen van type" all={typeNames} selected={draft.subjectTypes}
        onChange={(subjectTypes) => set({ subjectTypes })}
      />

      {isRelation && (
        <TypeChecklist
          label={`…die minstens een ${relNoun} hebben van type`} all={typeNames} selected={draft.targetTypes}
          onChange={(targetTypes) => set({ targetTypes })}
        />
      )}

      <div style={styles.formRow}>
        {isRelation && (
          <label style={styles.fieldLabel}>
            Welke relaties tellen
            <select style={styles.input} value={draft.weight} onChange={(e) => set({ weight: e.target.value as 'primair' | 'any' })}>
              <option value="any">Elke relatie</option>
              <option value="primair">Alleen primaire relaties</option>
            </select>
          </label>
        )}
        {draft.kind === 'requires_tag_category' && (
          <label style={styles.fieldLabel}>
            Tag-categorie
            <input
              style={styles.input} list="control-rule-tag-categories" maxLength={100} value={draft.tagCategory ?? ''}
              onChange={(e) => set({ tagCategory: e.target.value })}
            />
            <datalist id="control-rule-tag-categories">
              {tagCategories.map((c) => <option key={c} value={c} />)}
            </datalist>
          </label>
        )}
        {draft.kind === 'required_field' && (
          <label style={styles.fieldLabel}>
            Verplicht veld
            <select style={styles.input} value={draft.field ?? ''} onChange={(e) => set({ field: (e.target.value || null) as ControlRuleField | null })}>
              <option value="">— kies —</option>
              {FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
            </select>
          </label>
        )}
        {isAttribute && (
          <label style={styles.fieldLabel}>
            Kenmerk
            <select
              style={styles.input} value={draft.attributeId ?? ''}
              onChange={(e) => set({ attributeId: e.target.value || null, operator: null, value: null, value2: null })}
            >
              <option value="">— kies —</option>
              {attributes.map((a) => <option key={a.id} value={a.id}>{a.label} ({a.id})</option>)}
            </select>
          </label>
        )}
        {isAttribute && attribute && (
          <label style={styles.fieldLabel}>
            Eis
            <select
              style={styles.input} value={draft.operator ?? ''}
              onChange={(e) => set({ operator: e.target.value || null, value: null, value2: null })}
            >
              <option value="">— kies —</option>
              {operators.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
            </select>
          </label>
        )}
        {isAttribute && shape === 'text' && (
          <label style={{ ...styles.fieldLabel, flex: '1 1 200px' }}>
            Tekst (niet hoofdlettergevoelig)
            <input
              style={styles.input} maxLength={200} value={typeof draft.value === 'string' ? draft.value : ''}
              placeholder="Geen inhoudelijke of gerubriceerde informatie."
              onChange={(e) => set({ value: e.target.value })}
            />
          </label>
        )}
        {isAttribute && (shape === 'number' || shape === 'range') && (
          <label style={styles.fieldLabel}>
            {shape === 'range' ? 'Van' : 'Getal'}
            <input
              style={{ ...styles.input, width: 110 }} type="number" step="any" value={typeof draft.value === 'number' ? draft.value : ''}
              onChange={(e) => set({ value: numberOrNull(e.target.value) })}
            />
          </label>
        )}
        {isAttribute && shape === 'range' && (
          <label style={styles.fieldLabel}>
            Tot en met
            <input
              style={{ ...styles.input, width: 110 }} type="number" step="any" value={typeof draft.value2 === 'number' ? draft.value2 : ''}
              onChange={(e) => set({ value2: numberOrNull(e.target.value) })}
            />
          </label>
        )}
        {isAttribute && shape === 'date' && (
          <label style={styles.fieldLabel}>
            Datum
            <input
              style={styles.input} type="date" value={typeof draft.value === 'string' ? draft.value : ''}
              onChange={(e) => set({ value: e.target.value || null })}
            />
          </label>
        )}
        {isAttribute && shape === 'days' && (
          <label style={styles.fieldLabel}>
            Aantal dagen
            <input
              style={{ ...styles.input, width: 90 }} type="number" min={0} max={36500} step={1} value={typeof draft.value === 'number' ? draft.value : ''}
              onChange={(e) => set({ value: e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value))) })}
            />
          </label>
        )}
        {!isAttribute && draft.kind !== 'required_field' && (
          <label style={styles.fieldLabel}>
            Minimaal
            <input
              style={{ ...styles.input, width: 80 }} type="number" min={0} max={1000} value={draft.min ?? ''}
              onChange={(e) => set({ min: numOrNull(e.target.value) })}
            />
          </label>
        )}
        {(isRelation || draft.kind === 'primary_parent_count') && (
          <label style={styles.fieldLabel}>
            Maximaal (optioneel)
            <input
              style={{ ...styles.input, width: 80 }} type="number" min={0} max={1000} value={draft.max ?? ''}
              onChange={(e) => set({ max: numOrNull(e.target.value) })}
            />
          </label>
        )}
      </div>

      {isAttribute && attributes.length === 0 && (
        <p style={styles.muted}>
          Er zijn nog geen kenmerken. Leg ze eerst vast in de sectie Kenmerken hierboven en sla ze op.
        </p>
      )}
      {isAttribute && shape === 'options' && attribute && (
        <fieldset style={styles.fieldset}>
          <legend style={styles.legend}>Waarden uit de keuzelijst</legend>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
            {attribute.options.map((o) => (
              <label key={o} style={styles.checkLabel}>
                <input
                  type="checkbox" checked={selectedOptions.includes(o)}
                  onChange={(e) => set({ value: e.target.checked ? [...selectedOptions, o] : selectedOptions.filter((x) => x !== o) })}
                />
                {o}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {isAttribute && (shape === 'days' || draft.operator === 'date_not_in_past') && (
        <p style={styles.muted}>
          Deze eis wordt getoetst tegen de datum van vandaag op het moment dat de boom wordt geopend. Een element kan
          dus een signaal krijgen zonder dat iemand iets wijzigt.
        </p>
      )}

      <label style={styles.fieldLabel}>
        Uitleg (optioneel) — waarom bestaat deze regel?
        <textarea
          style={{ ...styles.input, minHeight: 50 }} maxLength={500} value={draft.explanation}
          placeholder="Geen inhoudelijke of gerubriceerde informatie."
          onChange={(e) => set({ explanation: e.target.value })}
        />
      </label>

      <p style={styles.summary}>Voorbeeld: {summarizeRule(normalize(draft), attributes)}</p>

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={onApply} style={styles.primaryBtn}>{isNew ? 'Toevoegen' : 'Bijwerken'}</button>
        <button type="button" onClick={onCancel} style={styles.ghostBtn}>Annuleren</button>
      </div>
    </div>
  );
}

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Er ging iets mis.';
}

const styles: Record<string, React.CSSProperties> = {
  section: { marginTop: 18, paddingTop: 12, borderTop: '1px solid #e4e6ea' },
  h3: { fontSize: 14.5, margin: '0 0 6px' },
  hint: { fontSize: 12.5, color: '#444', margin: '0 0 4px' },
  muted: { color: '#7a8088', fontSize: 12.5, margin: '0 0 6px' },
  warn: { color: '#8a5a00', background: '#fff6e0', border: '1px solid #f0d9a0', borderRadius: 6, padding: '6px 10px', fontSize: 12.5 },
  error: { color: '#DC3545', fontSize: 13 },
  ruleRow: {
    display: 'flex', gap: 8, alignItems: 'flex-start',
    padding: '8px 10px', borderRadius: 8, background: '#f7f8fa', border: '1px solid #e4e6ea',
  },
  code: { fontSize: 12, background: '#eceef2', borderRadius: 4, padding: '1px 5px' },
  badge: { marginLeft: 6, fontSize: 11, color: '#666', border: '1px solid #ccc', borderRadius: 10, padding: '0 6px' },
  badgeError: { marginLeft: 6, fontSize: 11, color: '#DC3545', border: '1px solid #DC3545', borderRadius: 10, padding: '0 6px' },
  summary: { fontSize: 12.5, color: '#333', marginTop: 2 },
  explanation: { fontSize: 12, color: '#666', marginTop: 2, whiteSpace: 'pre-wrap' },
  form: { marginTop: 10, padding: 10, border: '1px solid #c9d3e6', borderRadius: 8, background: 'white', display: 'flex', flexDirection: 'column', gap: 8 },
  formRow: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: '#555' },
  fieldset: { border: '1px solid #e4e6ea', borderRadius: 6, padding: '6px 10px', margin: 0 },
  legend: { fontSize: 12, color: '#555', padding: '0 4px' },
  input: { padding: '6px 9px', borderRadius: 6, border: '1px solid #d0d4da', fontSize: 13, minWidth: 0 },
  checkLabel: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, whiteSpace: 'nowrap' },
  removeBtn: { border: 'none', background: 'none', color: '#DC3545', fontSize: 12.5, cursor: 'pointer', padding: '4px 6px' },
  linkBtn: { border: 'none', background: 'none', color: '#2F5597', fontSize: 12.5, cursor: 'pointer', padding: '4px 6px' },
  ghostBtn: { borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1.5px solid #d0d4da', background: 'white', color: '#444' },
  primaryBtn: { borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1.5px solid #2F5597', background: '#2F5597', color: 'white' },
};

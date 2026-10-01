import { useEffect, useState } from 'react';
import { ApiError } from '../api';
import type { ControlRule, ControlRuleField, ControlRuleKind, ControlRulesState } from '../types';

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

function typeList(types: string[]): string {
  if (types.length === 0) return '…';
  if (types.length === 1) return types[0];
  return `${types.slice(0, -1).join(', ')} of ${types[types.length - 1]}`;
}

// Leesbare samenvatting, bv. "Elk element van type Control heeft minstens 1
// ouder van type Capability." Geëxporteerd voor hergebruik in DOEL-63.
export function summarizeRule(r: ControlRule): string {
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
    min: 1, max: null, tagCategory: null, field: null, label: '', explanation: '', enabled: true,
  };
}

// Brengt een regel in de vorm die de server voor dit regeltype accepteert
// (niet-toepasselijke velden leeg) — zelfde normalisatie als de server.
function normalize(r: ControlRule): ControlRule {
  const isRelation = RELATION_KINDS.includes(r.kind);
  return {
    ...r,
    id: r.id.trim(),
    label: r.label.trim(),
    explanation: r.explanation.trim(),
    targetTypes: isRelation ? r.targetTypes : [],
    weight: isRelation ? r.weight : 'any',
    min: r.kind === 'required_field' ? null : (r.min ?? 1),
    max: r.kind === 'required_field' || r.kind === 'requires_tag_category' ? null : r.max,
    tagCategory: r.kind === 'requires_tag_category' ? (r.tagCategory?.trim() || null) : null,
    field: r.kind === 'required_field' ? r.field : null,
  };
}

function validateRule(r: ControlRule, others: ControlRule[], validTypes: Set<string>): string | null {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(r.id)) return 'Id: alleen letters, cijfers, - en _ (max. 40 tekens).';
  if (others.some((o) => o.id === r.id)) return `Id "${r.id}" bestaat al.`;
  if (!r.label) return 'Label is verplicht.';
  if (r.label.length > 120) return 'Label mag maximaal 120 tekens zijn.';
  if (r.explanation.length > 500) return 'Uitleg mag maximaal 500 tekens zijn.';
  if (r.subjectTypes.length === 0) return 'Kies minstens één elementtype waarop de regel van toepassing is.';
  if (RELATION_KINDS.includes(r.kind) && r.targetTypes.length === 0) return 'Kies minstens één type voor de relatie.';
  if (r.kind === 'requires_tag_category' && !r.tagCategory) return 'Kies of typ een tag-categorie.';
  if (r.kind === 'required_field' && !r.field) return 'Kies het verplichte veld.';
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
  const isInvalid = (r: ControlRule) => [...r.subjectTypes, ...r.targetTypes].some((t) => !validTypes.has(t));

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
    const problem = validateRule(draft, others, validTypes);
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
      setState({ ...state!, rules: result.rules, invalidRuleIds: result.invalidRuleIds });
      setDirty(false);
      setSaved(true);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={styles.section} aria-label="Controleregels">
      <h3 style={styles.h3}>Controleregels</h3>
      <p style={styles.hint}>
        Regels die controleren of de keten <em>gedocumenteerd</em> sluitend is (ontbrekende schakels) — niet of iets
        werkt. <strong>Leg alleen structuur vast; geen inhoudelijke of gerubriceerde informatie.</strong>
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
                {isInvalid(r) && (
                  <span style={styles.badgeError} title="Deze regel verwijst naar een elementtype dat niet (meer) bestaat; pas hem aan of verwijder hem.">
                    verwijst naar onbekend type
                  </span>
                )}
              </div>
              <div style={styles.summary}>{summarizeRule(r)}</div>
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
  draft, isNew, typeNames, tagCategories, error, onChange, onApply, onCancel,
}: {
  draft: ControlRule;
  isNew: boolean;
  typeNames: string[];
  tagCategories: string[];
  error: string | null;
  onChange: (d: ControlRule) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<ControlRule>) => onChange({ ...draft, ...patch });
  const isRelation = RELATION_KINDS.includes(draft.kind);
  const numOrNull = (v: string) => (v === '' ? null : Math.max(0, Math.floor(Number(v))));
  const relNoun = draft.kind === 'requires_incoming' ? 'kind' : 'ouder';

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
        {draft.kind !== 'required_field' && (
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

      <label style={styles.fieldLabel}>
        Uitleg (optioneel) — waarom bestaat deze regel?
        <textarea
          style={{ ...styles.input, minHeight: 50 }} maxLength={500} value={draft.explanation}
          placeholder="Geen inhoudelijke of gerubriceerde informatie."
          onChange={(e) => set({ explanation: e.target.value })}
        />
      </label>

      <p style={styles.summary}>Voorbeeld: {summarizeRule(normalize(draft))}</p>

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

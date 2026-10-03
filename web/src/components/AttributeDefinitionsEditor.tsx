import { useEffect, useState } from 'react';
import { ApiError } from '../api';
import type { AttributeDef, AttributeDefsState, AttributeKind } from '../types';

// Beheer van kenmerkdefinities (DOEL-75, epic DOEL-61) — sectie tussen de
// kolommen en de controleregels in <ColumnConfigEditor>, voor de drie soorten
// config (tenant-default, doelenboom, sjabloon). De server
// (api/src/elementAttributes.ts) valideert alles en is de echte grens; hier
// alleen snelle feedback en een leesbare samenvatting.
//
// Alleen de DEFINITIES: de waarden per element volgen in DOEL-76, regels die
// kenmerken toetsen in DOEL-77.
//
// Alle door gebruikers ingevoerde tekst (labels, uitleg, keuzelijstwaarden,
// typenamen) wordt als gewone React-tekst gerenderd — dus altijd ge-escaped;
// geen ruwe HTML, geen inline handlers in HTML-strings.

export const ATTRIBUTE_KIND_LABELS: Record<AttributeKind, string> = {
  text: 'Tekst',
  number: 'Getal',
  date: 'Datum',
  choice: 'Keuzelijst (één waarde)',
  boolean: 'Ja/nee',
};

const KINDS = Object.keys(ATTRIBUTE_KIND_LABELS) as AttributeKind[];
const MAX_ATTRIBUTES = 30;
const MAX_LABEL = 60;
const MAX_EXPLANATION = 300;
const MAX_OPTIONS = 50;
const MAX_OPTION = 60;

function typeList(types: string[]): string {
  if (types.length === 0) return '…';
  if (types.length === 1) return types[0];
  return `${types.slice(0, -1).join(', ')} en ${types[types.length - 1]}`;
}

function nextAttributeId(attributes: AttributeDef[]): string {
  let n = attributes.length + 1;
  const ids = new Set(attributes.map((a) => a.id));
  while (ids.has(`K${String(n).padStart(2, '0')}`)) n += 1;
  return `K${String(n).padStart(2, '0')}`;
}

function emptyAttribute(id: string): AttributeDef {
  return { id, label: '', kind: 'text', subjectTypes: [], required: false, explanation: '', options: [] };
}

// De keuzelijst wordt bewerkt als tekstvak met één waarde per regel.
function optionsFromText(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

// Brengt een definitie in de vorm die de server accepteert (zelfde
// normalisatie als de server: getrimd, keuzelijst leeg bij andere soorten).
function normalize(a: AttributeDef): AttributeDef {
  return {
    ...a,
    id: a.id.trim(),
    label: a.label.trim(),
    explanation: a.explanation.trim(),
    options: a.kind === 'choice' ? a.options.map((o) => o.trim()).filter((o) => o !== '') : [],
  };
}

function validateAttribute(a: AttributeDef, others: AttributeDef[], validTypes: Set<string>): string | null {
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(a.id)) return 'Id: alleen letters, cijfers, - en _ (max. 30 tekens).';
  if (others.some((o) => o.id === a.id)) return `Id "${a.id}" bestaat al.`;
  if (!a.label) return 'Label is verplicht.';
  if (a.label.length > MAX_LABEL) return `Label mag maximaal ${MAX_LABEL} tekens zijn.`;
  if (others.some((o) => o.label.toLocaleLowerCase('nl') === a.label.toLocaleLowerCase('nl'))) {
    return 'Dit label wordt al gebruikt door een ander kenmerk.';
  }
  if (a.explanation.length > MAX_EXPLANATION) return `Uitleg mag maximaal ${MAX_EXPLANATION} tekens zijn.`;
  if (a.subjectTypes.length === 0) return 'Kies minstens één elementtype waarvoor het kenmerk geldt.';
  const unknown = a.subjectTypes.filter((t) => !validTypes.has(t));
  if (unknown.length) return `Onbekend(e) type(n): ${unknown.join(', ')}.`;
  if (a.kind === 'choice') {
    if (a.options.length === 0) return 'Een keuzelijst heeft minstens één waarde nodig.';
    if (a.options.length > MAX_OPTIONS) return `Een keuzelijst mag maximaal ${MAX_OPTIONS} waarden bevatten.`;
    if (a.options.some((o) => o.length > MAX_OPTION)) return `Een waarde in de keuzelijst mag maximaal ${MAX_OPTION} tekens zijn.`;
    if (new Set(a.options).size !== a.options.length) return 'De keuzelijst bevat een waarde meer dan één keer.';
  }
  return null;
}

export default function AttributeDefinitionsEditor({
  load,
  save,
  hideWhenModuleInactive,
}: {
  load: () => Promise<AttributeDefsState>;
  save: (attributes: AttributeDef[]) => Promise<{ attributes: AttributeDef[]; invalidAttributeIds: string[] }>;
  // true voor de kenmerken van één doelenboom: zonder actieve module wordt de
  // sectie volledig verborgen (zichtbaarheidsprincipe, licentiemodel §3).
  // Tenant-default en sjablonen tonen de sectie altijd (configuratie voor
  // nieuwe bomen), met een melding als de module niet actief is.
  hideWhenModuleInactive: boolean;
}) {
  const [state, setState] = useState<AttributeDefsState | null>(null);
  const [attributes, setAttributes] = useState<AttributeDef[]>([]);
  const [editing, setEditing] = useState<{ index: number | null; draft: AttributeDef; optionsText: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    load()
      .then((s) => {
        setState(s);
        setAttributes(s.attributes);
      })
      .catch((err) => setError(errMsg(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!state) return error ? <p style={styles.error}>{error}</p> : null;
  if (hideWhenModuleInactive && !state.moduleActive) return null;

  const validTypes = new Set(state.validTypeNames);
  const isInvalid = (a: AttributeDef) => a.subjectTypes.some((t) => !validTypes.has(t));
  // De soort ligt vast zodra het kenmerk is opgeslagen (server weigert een wijziging).
  const storedIds = new Set(state.attributes.map((a) => a.id));

  function change(next: AttributeDef[]) {
    setAttributes(next);
    setDirty(true);
    setSaved(false);
  }

  function startAdd() {
    setFormError(null);
    setEditing({ index: null, draft: emptyAttribute(nextAttributeId(attributes)), optionsText: '' });
  }

  function startEdit(index: number) {
    setFormError(null);
    setEditing({ index, draft: { ...attributes[index] }, optionsText: attributes[index].options.join('\n') });
  }

  function applyDraft() {
    if (!editing) return;
    const draft = normalize({ ...editing.draft, options: optionsFromText(editing.optionsText) });
    const others = attributes.filter((_, i) => i !== editing.index);
    const problem = validateAttribute(draft, others, validTypes);
    if (problem) {
      setFormError(problem);
      return;
    }
    change(editing.index == null ? [...attributes, draft] : attributes.map((a, i) => (i === editing.index ? draft : a)));
    setEditing(null);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await save(attributes.map(normalize));
      setAttributes(result.attributes);
      // Na opslaan zijn de waarden van verwijderde kenmerken en
      // keuzelijstwaarden opgeruimd (DOEL-76): de aantallen bijwerken.
      const valueCounts: NonNullable<AttributeDefsState['valueCounts']> = {};
      for (const a of result.attributes) {
        const c = state!.valueCounts?.[a.id];
        if (!c) continue;
        const kept = Object.entries(c.byOption).filter(([o]) => a.options.includes(o));
        const lost = Object.entries(c.byOption).filter(([o]) => !a.options.includes(o)).reduce((sum, [, n]) => sum + n, 0);
        valueCounts[a.id] = { total: c.total - lost, byOption: Object.fromEntries(kept) };
      }
      setState({ ...state!, attributes: result.attributes, invalidAttributeIds: result.invalidAttributeIds, valueCounts });
      setDirty(false);
      setSaved(true);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  // DOEL-76: ingevulde waarden horen bij een kenmerk-id (en bij een
  // keuzelijst bij een waarde uit de lijst); verdwijnt die, dan wist de server
  // de waarden bij het opslaan. Vooraf melden hoeveel dat er zijn.
  const counts = state.valueCounts ?? {};
  const currentById = new Map(attributes.map((a) => [a.id, a]));
  const removedIds = Object.keys(counts).filter((id) => !currentById.has(id) && counts[id].total > 0);
  const removedOptionIds: string[] = [];
  let lostValues = removedIds.reduce((sum, id) => sum + counts[id].total, 0);
  for (const a of attributes) {
    if (a.kind !== 'choice' || !counts[a.id]) continue;
    const lost = Object.entries(counts[a.id].byOption).filter(([o]) => !a.options.includes(o)).reduce((sum, [, n]) => sum + n, 0);
    if (lost > 0) {
      removedOptionIds.push(a.id);
      lostValues += lost;
    }
  }

  return (
    <section style={styles.section} aria-label="Kenmerken">
      <h3 style={styles.h3}>Kenmerken</h3>
      <p style={styles.hint}>
        Eigen velden per elementtype, bijvoorbeeld een datum of een keuze uit een lijst.{' '}
        <strong>Leg alleen kenmerken vast die metagegevens zijn; geen inhoudelijke of gerubriceerde informatie.</strong>
      </p>
      <p style={styles.muted}>
        Het id en de soort van een kenmerk liggen vast na het opslaan. De keuzelijst met elementtypen toont de{' '}
        <em>opgeslagen</em> kolommen en aliassen — sla gewijzigde kolommen eerst op.
      </p>
      {!state.moduleActive && (
        <p style={styles.warn}>
          De module Controleregels is niet actief voor deze tenant: kenmerken worden wel bewaard, maar pas gebruikt in
          een tenant met deze module.
        </p>
      )}
      {error && <p style={styles.error}>{error}</p>}

      {attributes.length === 0 && <p style={styles.muted}>Nog geen kenmerken.</p>}
      {lostValues > 0 && (
        <p style={styles.warn} role="alert">
          Let op: bij opslaan {lostValues === 1 ? 'vervalt 1 ingevulde waarde' : `vervallen ${lostValues} ingevulde waarden`} op
          elementen
          {removedIds.length > 0 && <> van {removedIds.length === 1 ? 'het verwijderde kenmerk' : 'de verwijderde kenmerken'} {removedIds.join(', ')}</>}
          {removedIds.length > 0 && removedOptionIds.length > 0 && ' en'}
          {removedOptionIds.length > 0 && <> door verwijderde keuzelijstwaarden bij {removedOptionIds.join(', ')}</>}
          . Dit kan niet ongedaan worden gemaakt.
        </p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {attributes.map((a, i) => (
          <div key={a.id} style={styles.row}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>
                <code style={styles.code}>{a.id}</code> <strong>{a.label}</strong>
                <span style={styles.badge}>{ATTRIBUTE_KIND_LABELS[a.kind]}</span>
                <span style={styles.badge}>{a.required ? 'verplicht' : 'optioneel'}</span>
                {(counts[a.id]?.total ?? 0) > 0 && (
                  <span style={styles.badge} title="Aantal elementen waarbij dit kenmerk is ingevuld. Verwijderen van het kenmerk wist deze waarden.">
                    {counts[a.id].total} ingevuld
                  </span>
                )}
                {isInvalid(a) && (
                  <span style={styles.badgeError} title="Dit kenmerk verwijst naar een elementtype dat niet (meer) bestaat; pas het aan of verwijder het.">
                    verwijst naar onbekend type
                  </span>
                )}
              </div>
              <div style={styles.summary}>Geldt voor elementen van type {typeList(a.subjectTypes)}.</div>
              {a.kind === 'choice' && <div style={styles.summary}>Waarden: {a.options.join(' · ')}</div>}
              {a.explanation && <div style={styles.explanation}>{a.explanation}</div>}
            </div>
            <button type="button" disabled={busy} onClick={() => startEdit(i)} style={styles.linkBtn}>Bewerken</button>
            <button type="button" disabled={busy} onClick={() => change(attributes.filter((_, xi) => xi !== i))} style={styles.removeBtn}>
              Verwijderen
            </button>
          </div>
        ))}
      </div>

      {editing && (
        <AttributeForm
          draft={editing.draft}
          optionsText={editing.optionsText}
          isNew={editing.index == null}
          kindLocked={storedIds.has(editing.draft.id) && editing.index != null}
          typeNames={state.validTypeNames}
          error={formError}
          onChange={(draft) => setEditing({ ...editing, draft })}
          onOptionsText={(optionsText) => setEditing({ ...editing, optionsText })}
          onApply={applyDraft}
          onCancel={() => setEditing(null)}
        />
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
        {!editing && (
          <button type="button" disabled={busy || attributes.length >= MAX_ATTRIBUTES} onClick={startAdd} style={styles.ghostBtn}>
            + Kenmerk toevoegen
          </button>
        )}
        <button type="button" disabled={busy || !dirty || !!editing} onClick={submit} style={styles.primaryBtn}>
          Kenmerken opslaan
        </button>
        {dirty && !saved && <span style={styles.muted}>Niet opgeslagen wijzigingen.</span>}
        {saved && <span style={{ color: '#2e7d32', fontSize: 12.5 }}>Opgeslagen.</span>}
      </div>
    </section>
  );
}

function AttributeForm({
  draft, optionsText, isNew, kindLocked, typeNames, error, onChange, onOptionsText, onApply, onCancel,
}: {
  draft: AttributeDef;
  optionsText: string;
  isNew: boolean;
  kindLocked: boolean;
  typeNames: string[];
  error: string | null;
  onChange: (d: AttributeDef) => void;
  onOptionsText: (text: string) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<AttributeDef>) => onChange({ ...draft, ...patch });
  const toggleType = (t: string, on: boolean) =>
    set({ subjectTypes: on ? [...draft.subjectTypes, t] : draft.subjectTypes.filter((x) => x !== t) });

  return (
    <div style={styles.form}>
      {error && <p style={styles.error}>{error}</p>}
      <div style={styles.formRow}>
        <label style={styles.fieldLabel}>
          Id
          <input
            style={{ ...styles.input, width: 110 }} value={draft.id} disabled={!isNew} maxLength={30}
            title="Stabiele sleutel van het kenmerk; na opslaan niet meer te wijzigen en nooit hergebruiken voor een andere betekenis."
            onChange={(e) => set({ id: e.target.value })}
          />
        </label>
        <label style={styles.fieldLabel}>
          Soort
          <select
            style={styles.input} value={draft.kind} disabled={kindLocked}
            title={kindLocked ? 'De soort ligt vast na het opslaan. Verwijder het kenmerk en maak een nieuw aan voor een andere soort.' : undefined}
            onChange={(e) => set({ kind: e.target.value as AttributeKind })}
          >
            {KINDS.map((k) => <option key={k} value={k}>{ATTRIBUTE_KIND_LABELS[k]}</option>)}
          </select>
        </label>
        <label style={{ ...styles.fieldLabel, flex: '1 1 240px' }}>
          Label
          <input
            style={styles.input} value={draft.label} maxLength={MAX_LABEL} placeholder="Naam van het kenmerk"
            onChange={(e) => set({ label: e.target.value })}
          />
        </label>
        <label style={{ ...styles.checkLabel, paddingBottom: 7 }}>
          <input type="checkbox" checked={draft.required} onChange={(e) => set({ required: e.target.checked })} />
          Verplicht
        </label>
      </div>

      <fieldset style={styles.fieldset}>
        <legend style={styles.legend}>Geldt voor elementen van type</legend>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
          {typeNames.map((t) => (
            <label key={t} style={styles.checkLabel}>
              <input type="checkbox" checked={draft.subjectTypes.includes(t)} onChange={(e) => toggleType(t, e.target.checked)} />
              {t}
            </label>
          ))}
          {/* Typen in het kenmerk die niet (meer) bestaan — zichtbaar zodat ze uitgevinkt kunnen worden. */}
          {draft.subjectTypes.filter((t) => !typeNames.includes(t)).map((t) => (
            <label key={`x-${t}`} style={{ ...styles.checkLabel, color: '#DC3545' }}>
              <input type="checkbox" checked onChange={() => toggleType(t, false)} />
              {t} (bestaat niet meer)
            </label>
          ))}
        </div>
      </fieldset>

      {draft.kind === 'choice' && (
        <label style={styles.fieldLabel}>
          Waarden van de keuzelijst — één per regel (max. {MAX_OPTIONS} waarden van {MAX_OPTION} tekens)
          <textarea
            style={{ ...styles.input, minHeight: 80 }} value={optionsText}
            placeholder="Geen inhoudelijke of gerubriceerde informatie."
            onChange={(e) => onOptionsText(e.target.value)}
          />
        </label>
      )}

      <label style={styles.fieldLabel}>
        Uitleg (optioneel) — wat leg je met dit kenmerk vast?
        <textarea
          style={{ ...styles.input, minHeight: 50 }} maxLength={MAX_EXPLANATION} value={draft.explanation}
          placeholder="Geen inhoudelijke of gerubriceerde informatie."
          onChange={(e) => set({ explanation: e.target.value })}
        />
      </label>

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
  row: {
    display: 'flex', gap: 8, alignItems: 'flex-start',
    padding: '8px 10px', borderRadius: 8, background: '#f7f8fa', border: '1px solid #e4e6ea',
  },
  code: { fontSize: 12, background: '#eceef2', borderRadius: 4, padding: '1px 5px' },
  badge: { marginLeft: 6, fontSize: 11, color: '#666', border: '1px solid #ccc', borderRadius: 10, padding: '0 6px' },
  badgeError: { marginLeft: 6, fontSize: 11, color: '#DC3545', border: '1px solid #DC3545', borderRadius: 10, padding: '0 6px' },
  summary: { fontSize: 12.5, color: '#333', marginTop: 2, overflowWrap: 'anywhere' },
  explanation: { fontSize: 12, color: '#666', marginTop: 2, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
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

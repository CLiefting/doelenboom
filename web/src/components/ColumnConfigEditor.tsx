import { useEffect, useState } from 'react';
import { ApiError } from '../api';
import type { ColumnDef } from '../types';

// Generieke editor voor een kolomconfiguratie (tenant-default óf de eigen
// config van één doelenboom, zie docs/kolommen-configuratie-ontwerp.md) — de
// twee call-sites (TenantManagementPage: "Standaardkolommen" per tenant en
// "Kolommen" per doelenboom) geven alleen hun eigen load/save-functie mee,
// de rest van het formulier (toevoegen/verwijderen/herordenen/valideren) is
// identiek. Validatie hier is een client-side kopie van validateColumnsInput
// in api/src/columnConfig.ts — puur om snelle feedback te geven vóór het
// versturen; de server valideert sowieso nog een keer (en is de echte grens).
function emptyColumn(position: number, color: string): ColumnDef {
  return {
    position,
    typeName: '',
    title: '',
    subtitle: '',
    color,
    isNarrow: false,
    nodeFontSize: null,
    isProjectRole: false,
    relationLabelToNext: '',
  };
}

// Startkleur voor een nieuw toegevoegde kolom (cyclisch door dit rijtje) —
// puur om niet met zwart/willekeurig te beginnen, verder geen betekenis.
const DEFAULT_COLOR_PALETTE = ['#3E6FA6', '#6B4C8A', '#C05A2C', '#B8862E', '#2E7D5B', '#8FAADC', '#2F5597', '#203864'];

export default function ColumnConfigEditor({
  load,
  save,
}: {
  load: () => Promise<{ columns: ColumnDef[] }>;
  save: (columns: ColumnDef[]) => Promise<{ columns: ColumnDef[] }>;
}) {
  const [columns, setColumns] = useState<ColumnDef[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    load()
      .then((r) => setColumns(r.columns))
      .catch((err) => setError(errMsg(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!columns) {
    return error ? <p style={styles.error}>{error}</p> : <p style={styles.muted}>Laden…</p>;
  }

  function update(idx: number, patch: Partial<ColumnDef>) {
    setSaved(false);
    setColumns((cols) => (cols ?? []).map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }

  function move(idx: number, dir: -1 | 1) {
    setSaved(false);
    setColumns((cols) => {
      const list = (cols ?? []).slice();
      const target = idx + dir;
      if (target < 0 || target >= list.length) return list;
      [list[idx], list[target]] = [list[target], list[idx]];
      return list.map((c, i) => ({ ...c, position: i }));
    });
  }

  function removeRow(idx: number) {
    setSaved(false);
    setColumns((cols) => (cols ?? []).filter((_, i) => i !== idx).map((c, i) => ({ ...c, position: i })));
  }

  function addRow() {
    setSaved(false);
    setColumns((cols) => {
      const list = cols ?? [];
      const color = DEFAULT_COLOR_PALETTE[list.length % DEFAULT_COLOR_PALETTE.length];
      return [...list, emptyColumn(list.length, color)];
    });
  }

  function setProjectRole(idx: number) {
    setSaved(false);
    setColumns((cols) => (cols ?? []).map((c, i) => ({ ...c, isProjectRole: i === idx })));
  }

  function validateClientSide(cols: ColumnDef[]): string | null {
    if (cols.length === 0) return 'Minstens één kolom is verplicht.';
    const seen = new Set<string>();
    for (const c of cols) {
      if (!c.typeName.trim()) return 'Elke kolom moet een type-naam hebben.';
      if (!c.title.trim()) return 'Elke kolom moet een titel hebben.';
      if (!/^#[0-9a-fA-F]{6}$/.test(c.color)) {
        return `Kleur van "${c.typeName || c.title}" moet een geldige hex-waarde zijn (bv. #3E6FA6).`;
      }
      const key = c.typeName.trim();
      if (seen.has(key)) return `Type-naam "${c.typeName}" komt meer dan één keer voor.`;
      seen.add(key);
    }
    if (cols.filter((c) => c.isProjectRole).length !== 1) {
      return 'Precies één kolom moet als "projectrol" zijn aangevinkt (nodig voor de projectkaart/planning-items/tijdlijnenoverzicht).';
    }
    return null;
  }

  async function submit() {
    const validationError = validateClientSide(columns!);
    if (validationError) {
      setError(validationError);
      setSaved(false);
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // De laatste kolom heeft per definitie geen "volgende" kolom meer —
      // zelfde regel als validateColumnsInput() server-side.
      const toSave = columns!.map((c, i) => ({
        ...c,
        position: i,
        relationLabelToNext: i === columns!.length - 1 ? null : (c.relationLabelToNext?.trim() || null),
      }));
      const result = await save(toSave);
      setColumns(result.columns);
      setSaved(true);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {error && <p style={styles.error}>{error}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {columns.map((c, idx) => (
          <div key={idx} style={styles.row}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <button type="button" disabled={busy || idx === 0} onClick={() => move(idx, -1)} style={styles.arrowBtn} title="Omhoog verplaatsen">▲</button>
              <button type="button" disabled={busy || idx === columns.length - 1} onClick={() => move(idx, 1)} style={styles.arrowBtn} title="Omlaag verplaatsen">▼</button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, flex: 1, alignItems: 'center' }}>
              <input
                style={styles.input} placeholder="Type-naam" disabled={busy} value={c.typeName}
                onChange={(e) => update(idx, { typeName: e.target.value })}
              />
              <input
                style={styles.input} placeholder="Titel" disabled={busy} value={c.title}
                onChange={(e) => update(idx, { title: e.target.value })}
              />
              <input
                style={{ ...styles.input, flex: '1 1 220px' }} placeholder="Ondertitel (optioneel)" disabled={busy} value={c.subtitle}
                onChange={(e) => update(idx, { subtitle: e.target.value })}
              />
              <input
                type="color" title="Kleur" disabled={busy} style={styles.colorInput}
                value={/^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color : '#000000'}
                onChange={(e) => update(idx, { color: e.target.value })}
              />
              <input
                style={{ ...styles.input, width: 90, flex: '0 0 90px' }} placeholder="#RRGGBB" disabled={busy} value={c.color}
                onChange={(e) => update(idx, { color: e.target.value })}
              />
              <input
                style={{ ...styles.input, width: 150, flex: '0 0 150px' }} type="number" min={1} placeholder="lettergrootte (std. 8)"
                disabled={busy} value={c.nodeFontSize ?? ''}
                onChange={(e) => update(idx, { nodeFontSize: e.target.value ? Number(e.target.value) : null })}
              />
              {idx < columns.length - 1 && (
                <input
                  style={{ ...styles.input, flex: '1 1 200px' }} placeholder='Relatie naar volgende kolom (bv. "ondersteunt")'
                  disabled={busy} value={c.relationLabelToNext ?? ''}
                  onChange={(e) => update(idx, { relationLabelToNext: e.target.value })}
                />
              )}
              <label style={styles.checkLabel}>
                <input type="checkbox" checked={c.isNarrow} disabled={busy} onChange={(e) => update(idx, { isNarrow: e.target.checked })} />
                Smal
              </label>
              <label style={styles.checkLabel} title='Precies één kolom moet dit hebben — bepaalt welk elementtype als "project" telt (projectkaart/planning/tijdlijnen)'>
                <input type="radio" name="project-role" checked={c.isProjectRole} disabled={busy} onChange={() => setProjectRole(idx)} />
                Projectrol
              </label>
              <button type="button" disabled={busy} onClick={() => removeRow(idx)} style={styles.removeBtn}>
                Verwijderen
              </button>
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
        <button type="button" disabled={busy} onClick={addRow} style={styles.ghostBtn}>
          + Kolom toevoegen
        </button>
        <button type="button" disabled={busy} onClick={submit} style={styles.primaryBtn}>
          Opslaan
        </button>
        {saved && <span style={{ color: '#2e7d32', fontSize: 12.5 }}>Opgeslagen.</span>}
      </div>
    </div>
  );
}

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Er ging iets mis.';
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex', gap: 8, alignItems: 'flex-start',
    padding: '8px 10px', borderRadius: 8, background: '#f7f8fa', border: '1px solid #e4e6ea',
  },
  arrowBtn: {
    width: 22, height: 18, fontSize: 10, lineHeight: 1, padding: 0, cursor: 'pointer',
    border: '1px solid #d0d4da', borderRadius: 4, background: 'white',
  },
  input: { padding: '7px 10px', borderRadius: 6, border: '1px solid #d0d4da', fontSize: 13, flex: '1 1 130px', minWidth: 0 },
  colorInput: { width: 34, height: 32, padding: 2, borderRadius: 6, border: '1px solid #d0d4da', cursor: 'pointer', flex: '0 0 auto' },
  checkLabel: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, whiteSpace: 'nowrap' },
  removeBtn: { border: 'none', background: 'none', color: '#DC3545', fontSize: 12.5, cursor: 'pointer', padding: '4px 6px' },
  ghostBtn: { borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1.5px solid #d0d4da', background: 'white', color: '#444' },
  primaryBtn: { borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1.5px solid #2F5597', background: '#2F5597', color: 'white' },
  muted: { color: '#9aa0a8', fontSize: 13, margin: 0 },
  error: { color: '#DC3545', fontSize: 13 },
};

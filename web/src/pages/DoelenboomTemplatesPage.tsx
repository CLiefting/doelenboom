import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import ColumnConfigEditor from '../components/ColumnConfigEditor';
import type { DoelenboomSummary, DoelenboomTemplateSummary } from '../types';

// Sjablonenbeheer — apart, tenant-overstijgend scherm (i.t.t. het kleine
// sjablonenlijstje dat voorheen per tenant in TenantManagementPage stond):
// hier zie je in één overzicht alle sjablonen die je mag beheren — voor een
// sysadmin is dat alles (systeembreed + van elke tenant), voor een
// tenant-admin systeembreed + de sjablonen van de eigen tenant(s). Rechten
// worden hoe dan ook server-side afgedwongen (zie api/src/routes/
// doelenboomTemplates.ts, requireManageTemplate) — dit scherm toont gewoon
// wat GET /api/doelenboom-templates teruggeeft.
//
// Een sjabloon "bewerken" bestaat uit drie losse acties: naam/omschrijving
// aanpassen, de kolommen rechtstreeks bewerken (hergebruikt dezelfde
// <ColumnConfigEditor> als bij tenant-default/doelenboom-kolommen), of de
// hele inhoud (kolommen + voorbeeldelementen + relaties) in één keer
// vervangen vanuit een bestaande, echte doelenboom — geen los sjabloon-
// aanmaakformulier hier, dat blijft "Opslaan als sjabloon" bij de boom zelf
// (TenantManagementPage), want daar hoort de brondata al vandaan te komen.
export default function DoelenboomTemplatesPage({
  token,
  onBack,
}: {
  token: string;
  onBack: () => void;
}) {
  const [templates, setTemplates] = useState<DoelenboomTemplateSummary[] | null>(null);
  const [doelenbomen, setDoelenbomen] = useState<DoelenboomSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function loadTemplates() {
    api.allDoelenboomTemplates(token).then(setTemplates).catch((err) => setError(errMsg(err)));
  }

  useEffect(() => {
    loadTemplates();
    // Voor de "vervangen vanuit boom"-kiezer — één keer voor de hele
    // paginalijst laden i.p.v. per sjabloon-rij opnieuw.
    api.doelenbomen(token).then(setDoelenbomen).catch((err) => setError(errMsg(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function remove(t: DoelenboomTemplateSummary) {
    const ok = window.confirm(
      `Sjabloon "${t.name}" verwijderen? Dit heeft geen effect op doelenbomen die er al mee zijn aangemaakt.`
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteDoelenboomTemplate(token, t.id);
      loadTemplates();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Sjablonenbeheer</h1>
          <p style={styles.subtitle}>
            Systeembrede sjablonen en die van je eigen tenant(s) — kolommen + voorbeeldelementen waarmee een
            nieuwe doelenboom snel op de juiste structuur start.
          </p>
        </div>
        <button onClick={onBack} style={btnStyle('ghost')}>← Terug</button>
      </header>

      {error && <p style={styles.error}>{error}</p>}

      <section style={styles.section}>
        {!templates && <p style={styles.muted}>Laden…</p>}
        {templates && templates.length === 0 && (
          <p style={styles.muted}>
            Geen sjablonen om te beheren. Sjablonen maak je aan via "Opslaan als sjabloon" bij een doelenboom in
            Tenantbeheer.
          </p>
        )}
        {templates && templates.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {templates.map((t) => (
              <TemplateRow
                key={t.id}
                token={token}
                template={t}
                doelenbomen={doelenbomen ?? []}
                busy={busy}
                setBusy={setBusy}
                setError={setError}
                onChanged={loadTemplates}
                onRemove={() => remove(t)}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function TemplateRow({
  token,
  template,
  doelenbomen,
  busy,
  setBusy,
  setError,
  onChanged,
  onRemove,
}: {
  token: string;
  template: DoelenboomTemplateSummary;
  doelenbomen: DoelenboomSummary[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onChanged: () => void;
  onRemove: () => void;
}) {
  const [mode, setMode] = useState<'view' | 'meta' | 'columns' | 'refresh'>('view');

  return (
    <div style={styles.row}>
      <div style={styles.rowHeader}>
        <div>
          <strong>{template.name}</strong>{' '}
          {template.tenantId == null ? (
            <span style={styles.badge} title="Systeembreed sjabloon">🌐 systeembreed</span>
          ) : (
            <span style={styles.badge}>{template.tenantName ?? `tenant #${template.tenantId}`}</span>
          )}
          {template.description && <p style={styles.description}>{template.description}</p>}
        </div>
        {mode === 'view' && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button disabled={busy} onClick={() => setMode('meta')} style={btnStyle('ghost')}>
              Bewerken
            </button>
            <button disabled={busy} onClick={() => setMode('columns')} style={btnStyle('ghost')}>
              Kolommen
            </button>
            <button disabled={busy} onClick={() => setMode('refresh')} style={btnStyle('ghost')}>
              Vervangen vanuit boom
            </button>
            <button disabled={busy} onClick={onRemove} style={btnStyle('danger-text')}>
              Verwijderen
            </button>
          </div>
        )}
      </div>

      {mode === 'meta' && (
        <EditMetaForm
          token={token}
          template={template}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          onSaved={() => {
            setMode('view');
            onChanged();
          }}
          onCancel={() => setMode('view')}
        />
      )}

      {mode === 'columns' && (
        <div style={styles.subsection}>
          <ColumnConfigEditor
            load={() => api.templateColumnConfig(token, template.id)}
            save={(columns) => api.updateTemplateColumnConfig(token, template.id, columns)}
          />
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={() => setMode('view')} style={btnStyle('ghost')} disabled={busy}>
              Sluiten
            </button>
          </div>
        </div>
      )}

      {mode === 'refresh' && (
        <RefreshFromDoelenboomForm
          token={token}
          template={template}
          doelenbomen={doelenbomen}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          onDone={() => {
            setMode('view');
            onChanged();
          }}
          onCancel={() => setMode('view')}
        />
      )}
    </div>
  );
}

function EditMetaForm({
  token,
  template,
  busy,
  setBusy,
  setError,
  onSaved,
  onCancel,
}: {
  token: string;
  template: DoelenboomTemplateSummary;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateDoelenboomTemplateMeta(token, template.id, { name, description });
      onSaved();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={styles.subsection}>
      <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="naam" required />
      <input
        style={{ ...styles.input, marginTop: 8 }}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="omschrijving (optioneel)"
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" onClick={onCancel} style={btnStyle('ghost')} disabled={busy}>
          Annuleren
        </button>
        <button type="submit" style={btnStyle('primary')} disabled={busy}>
          Opslaan
        </button>
      </div>
    </form>
  );
}

function RefreshFromDoelenboomForm({
  token,
  template,
  doelenbomen,
  busy,
  setBusy,
  setError,
  onDone,
  onCancel,
}: {
  token: string;
  template: DoelenboomTemplateSummary;
  doelenbomen: DoelenboomSummary[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [doelenboomId, setDoelenboomId] = useState<number | ''>('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!doelenboomId) {
      setError('Kies een doelenboom.');
      return;
    }
    const ok = window.confirm(
      `De huidige kolommen en voorbeeldelementen van sjabloon "${template.name}" worden vervangen door de ` +
      `inhoud van de gekozen boom. Dit kan niet ongedaan worden gemaakt. Doorgaan?`
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.refreshTemplateFromDoelenboom(token, template.id, doelenboomId);
      onDone();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={styles.subsection}>
      <p style={{ margin: '0 0 8px', fontSize: 13, color: '#6c6f76' }}>
        Vervangt de kolommen + voorbeeldelementen + relaties van "{template.name}" door de huidige inhoud van de
        gekozen boom. Je hebt zelf admin-toegang tot die boom nodig.
      </p>
      <select
        style={styles.input}
        value={doelenboomId}
        onChange={(e) => setDoelenboomId(e.target.value ? Number(e.target.value) : '')}
      >
        <option value="">— kies doelenboom —</option>
        {doelenbomen.map((d) => (
          <option key={d.id} value={d.id}>
            {d.tenant_name} — {d.name}
          </option>
        ))}
      </select>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" onClick={onCancel} style={btnStyle('ghost')} disabled={busy}>
          Annuleren
        </button>
        <button type="submit" style={btnStyle('primary')} disabled={busy}>
          Vervangen
        </button>
      </div>
    </form>
  );
}

function errMsg(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Er ging iets mis.';
}

function btnStyle(kind: 'ghost' | 'primary' | 'danger-text'): React.CSSProperties {
  const base: React.CSSProperties = {
    borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  };
  if (kind === 'ghost') return { ...base, border: '1.5px solid #d0d4da', background: 'white', color: '#444' };
  if (kind === 'danger-text') return { ...base, border: 'none', background: 'none', color: '#DC3545', padding: '4px 8px' };
  return { ...base, border: '1.5px solid #2F5597', background: '#2F5597', color: 'white' };
}

const styles: Record<string, React.CSSProperties> = {
  main: { fontFamily: 'system-ui, sans-serif', padding: 'clamp(1rem, 4vw, 2rem)', maxWidth: 860, margin: '0 auto' },
  // flexWrap: 'wrap' zodat de titel/knoppen op een smal (mobiel) scherm onder
  // elkaar komen i.p.v. van de rand af te lopen — zie doelenboom_mobiele_analyse.md.
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: '1.5rem' },
  title: { margin: 0, color: '#203864' },
  subtitle: { margin: '4px 0 0', color: '#6c6f76', fontSize: 13.5, maxWidth: 520 },
  section: { marginBottom: '2rem', background: 'white', borderRadius: 10, padding: '1.25rem 1.5rem', border: '1px solid #e4e6ea' },
  row: { border: '1px solid #e4e6ea', borderRadius: 8, padding: '10px 12px' },
  rowHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' },
  badge: {
    fontSize: 11, color: '#2F5597', background: '#EEF2FA', border: '1px solid #D6E0F5', borderRadius: 999,
    padding: '2px 8px', marginLeft: 4,
  },
  description: { margin: '4px 0 0', fontSize: 12.5, color: '#6c6f76' },
  subsection: { marginTop: 10, paddingTop: 10, borderTop: '1px solid #f0f1f3' },
  input: { padding: '7px 10px', borderRadius: 6, border: '1px solid #d0d4da', fontSize: 13, width: '100%', boxSizing: 'border-box' },
  muted: { color: '#9aa0a8', fontSize: 13, margin: 0 },
  error: { color: '#DC3545', fontSize: 13 },
};

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type { Tier, TenantSubscriptionOverviewRow } from '../types';

// Sorteerbaar abonnementenoverzicht, naast (niet i.p.v.) Tenantbeheer — zie
// GET /api/subscription-requests/overview / listTenantSubscriptionOverview in
// subscriptions.ts. Verzoek van Charles (30 augustus 2026): "welk abonnement
// bij de tenant hoort, tot wanneer, wie de aanvrager is en wat het email/tel
// nummer is ... kunnen sorteren op alle kolommen", uitgebreid (30 augustus
// 2026, tweede verzoek) met "deze gegevens ook kunnen wijzigen en
// betalingen (en daarmee abonnementen verlengen) kunnen registreren" — zie
// EditTenantModal hieronder. Eén rij per tenant, ook tenants die niet via de
// zelfbedieningsaanvraag zijn ontstaan (dan blijven status/aanvrager/e-mail/
// telefoon leeg — "—", en is er geen betaling/verlenging te registreren).
type SortKey = 'tenantName' | 'tierName' | 'licenseEndDate' | 'status' | 'applicantName' | 'applicantEmail' | 'applicantPhone';

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'tenantName', label: 'Tenant' },
  { key: 'tierName', label: 'Abonnement' },
  { key: 'licenseEndDate', label: 'Verloopt op' },
  { key: 'status', label: 'Status' },
  { key: 'applicantName', label: 'Aanvrager' },
  { key: 'applicantEmail', label: 'E-mail' },
  { key: 'applicantPhone', label: 'Telefoon' },
];

const STATUS_LABEL: Record<string, string> = { proef: 'Proef', actief: 'Actief', afgewezen: 'Afgewezen' };

export default function SubscriptionOverviewPage({ token, onBack }: { token: string; onBack: () => void }) {
  const [rows, setRows] = useState<TenantSubscriptionOverviewRow[] | null>(null);
  const [tiers, setTiers] = useState<Tier[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('tenantName');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [editing, setEditing] = useState<TenantSubscriptionOverviewRow | null>(null);

  function load() {
    api.subscriptionOverview(token).then(setRows).catch((err) => setError(errMsg(err)));
  }
  useEffect(load, [token]);
  useEffect(() => {
    api.tiers(token).then(setTiers).catch((err) => setError(errMsg(err)));
  }, [token]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = !q
      ? rows ?? []
      : (rows ?? []).filter((r) =>
          [r.tenantName, r.tenantSlug, r.tierName, r.applicantName, r.applicantEmail, r.applicantPhone]
            .filter(Boolean)
            .some((v) => (v as string).toLowerCase().includes(q))
        );
    // Ontbrekende waarden (null) staan altijd onderaan, ongeacht sorteerrichting
    // — anders "springt" een lege rij van onder- naar bovenaan zodra je de
    // richting omdraait, wat verwarrend is.
    const sorted = [...filtered].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = String(av).localeCompare(String(bv), 'nl', { sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [rows, query, sortKey, sortDir]);

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Abonnementenoverzicht</h1>
          <p style={styles.subtitle}>Eén rij per tenant — klik op een kolomkop om te sorteren, of op een rij om te bewerken.</p>
        </div>
        <button onClick={onBack} style={btnStyle('ghost')}>← Terug</button>
      </header>

      {error && <p style={styles.error}>{error}</p>}
      {!rows && !error && <p style={styles.muted}>Laden…</p>}

      {rows && (
        <section style={styles.section}>
          <input
            style={styles.search}
            placeholder="Zoek op tenant, abonnement, aanvrager, e-mail of telefoon…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c.key} style={styles.th} onClick={() => toggleSort(c.key)}>
                      {c.label}
                      <span style={styles.sortArrow}>{sortKey === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
                    </th>
                  ))}
                  <th style={{ ...styles.th, cursor: 'default' }}></th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => {
                  const color = licenseBorderColor(r.licenseEndDate);
                  return (
                    <tr key={r.tenantId} style={styles.rowClickable} onClick={() => setEditing(r)}>
                      <td style={styles.td}>
                        <strong>{r.tenantName}</strong>
                        <div style={styles.tenantSlug}>{r.tenantSlug}</div>
                      </td>
                      <td style={styles.td}>{r.tierName ?? '—'}</td>
                      <td style={{ ...styles.td, ...(color ? { color, fontWeight: 600 } : {}) }}>
                        {r.licenseEndDate ? formatDateNL(r.licenseEndDate) : '—'}
                      </td>
                      <td style={styles.td}>{r.status ? STATUS_LABEL[r.status] ?? r.status : '—'}</td>
                      <td style={styles.td}>{r.applicantName ?? '—'}</td>
                      <td style={styles.td}>{r.applicantEmail ?? '—'}</td>
                      <td style={styles.td}>{r.applicantPhone ?? '—'}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>
                        <button
                          style={btnStyle('ghost')}
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditing(r);
                          }}
                        >
                          Bewerken
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {visibleRows.length === 0 && (
                  <tr>
                    <td style={styles.td} colSpan={COLUMNS.length + 1}>
                      <span style={styles.muted}>Geen tenants gevonden.</span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {editing && (
        <EditTenantModal
          token={token}
          row={editing}
          tiers={tiers}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </main>
  );
}

// Bewerkmodal: abonnement (tier) en verloopdatum wijzigen hergebruiken de al
// bestaande, sysadmin-only licentie-endpoints (setTenantTier/
// setTenantLicenseEndDate — dezelfde die TenantLicensePanel.tsx gebruikt) en
// werken voor ELKE tenant, ook een handmatig aangemaakte zonder aanvraag.
// Aanvrager-/contactgegevens en betaling/verlenging registreren werken
// alleen als er een subscription_requests-rij is (row.requestId) — bij een
// handmatig aangemaakte tenant is die er niet.
function EditTenantModal({
  token,
  row,
  tiers,
  onClose,
  onSaved,
}: {
  token: string;
  row: TenantSubscriptionOverviewRow;
  tiers: Tier[] | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tierId, setTierId] = useState<string>(row.tierId != null ? String(row.tierId) : '');
  const [licenseEndDate, setLicenseEndDate] = useState(row.licenseEndDate ?? '');
  const [applicantName, setApplicantName] = useState(row.applicantName ?? '');
  const [applicantEmail, setApplicantEmail] = useState(row.applicantEmail ?? '');
  const [applicantPhone, setApplicantPhone] = useState(row.applicantPhone ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const calls: Promise<unknown>[] = [];

      const newTierId = tierId === '' ? null : Number(tierId);
      if (newTierId !== row.tierId) {
        calls.push(api.setTenantTier(token, row.tenantId, newTierId));
      }
      const newEndDate = licenseEndDate || null;
      if (newEndDate !== (row.licenseEndDate ?? null)) {
        calls.push(api.setTenantLicenseEndDate(token, row.tenantId, newEndDate));
      }

      if (row.requestId != null) {
        const applicantUpdates: { applicantName?: string; applicantEmail?: string; applicantPhone?: string | null } = {};
        if (applicantName.trim() !== (row.applicantName ?? '')) applicantUpdates.applicantName = applicantName.trim();
        if (applicantEmail.trim() !== (row.applicantEmail ?? '')) applicantUpdates.applicantEmail = applicantEmail.trim();
        if (applicantPhone.trim() !== (row.applicantPhone ?? '')) applicantUpdates.applicantPhone = applicantPhone.trim() || null;
        if (Object.keys(applicantUpdates).length > 0) {
          calls.push(api.updateSubscriptionRequestApplicant(token, row.requestId, applicantUpdates));
        }
      }

      if (calls.length === 0) return onClose();
      await Promise.all(calls);
      onSaved();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function registerPayment() {
    if (row.requestId == null) return;
    setBusy(true);
    setError(null);
    try {
      await api.registerSubscriptionPayment(token, row.requestId);
      onSaved();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function registerRenewal() {
    if (row.requestId == null) return;
    setBusy(true);
    setError(null);
    try {
      await api.registerSubscriptionRenewal(token, row.requestId);
      onSaved();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.overlay} onClick={onClose}>
      <form style={styles.modal} onClick={(e) => e.stopPropagation()} onSubmit={handleSave}>
        <h2 style={styles.h2}>Bewerken — {row.tenantName}</h2>
        {error && <p style={styles.error}>{error}</p>}

        <label style={styles.label}>
          Abonnement
          <select style={styles.input} value={tierId} onChange={(e) => setTierId(e.target.value)}>
            <option value="">— geen —</option>
            {tiers?.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>

        <label style={styles.label}>
          Verloopt op
          <input
            style={styles.input}
            type="date"
            value={licenseEndDate}
            onChange={(e) => setLicenseEndDate(e.target.value)}
          />
        </label>

        {row.requestId == null ? (
          <p style={styles.muted}>
            Deze tenant is handmatig aangemaakt (geen zelfbedieningsaanvraag) — er is geen aanvrager-/contactinfo of
            betaling/verlenging te registreren.
          </p>
        ) : (
          <>
            <p style={styles.hint}>
              Onderstaande wijzigt alleen de contactgegevens van de aanvraag, niet het inlogaccount van de aanvrager.
            </p>
            <label style={styles.label}>
              Aanvrager
              <input style={styles.input} value={applicantName} onChange={(e) => setApplicantName(e.target.value)} />
            </label>
            <label style={styles.label}>
              E-mail
              <input
                style={styles.input}
                type="email"
                value={applicantEmail}
                onChange={(e) => setApplicantEmail(e.target.value)}
              />
            </label>
            <label style={styles.label}>
              Telefoon
              <input style={styles.input} type="tel" value={applicantPhone} onChange={(e) => setApplicantPhone(e.target.value)} />
            </label>

            {row.status === 'proef' && (
              <button type="button" disabled={busy} onClick={registerPayment} style={{ ...btnStyle('primary'), marginBottom: 8 }}>
                Betaling registreren
              </button>
            )}
            {row.status === 'actief' && (
              <button type="button" disabled={busy} onClick={registerRenewal} style={{ ...btnStyle('primary'), marginBottom: 8 }}>
                Verlenging registreren
              </button>
            )}
          </>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="submit" disabled={busy} style={btnStyle('primary')}>Opslaan</button>
          <button type="button" onClick={onClose} style={btnStyle('ghost')}>Annuleren</button>
        </div>
      </form>
    </div>
  );
}

// Zelfde kleurindicatie-logica als TenantManagementPage.tsx licenseBorderColor
// (geen einddatum = geen kleur, groen verder dan een maand weg, oranje binnen
// een maand, rood al verlopen) — bewust hier gedupliceerd, zelfde conventie
// als elders in deze codebase (zie formatDateNL aldaar).
function licenseBorderColor(endDate: string | null): string | undefined {
  if (!endDate) return undefined;
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  if (endDate < todayStr) return '#DC3545';
  const oneMonthOut = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, today.getUTCDate()));
  const oneMonthStr = oneMonthOut.toISOString().slice(0, 10);
  if (endDate <= oneMonthStr) return '#E8A33D';
  return '#2e7d32';
}

function formatDateNL(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return dateStr;
  const [, y, mo, d] = m;
  return `${d}-${mo}-${y}`;
}

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Er ging iets mis.';
}

function btnStyle(kind: 'primary' | 'ghost'): React.CSSProperties {
  if (kind === 'primary') {
    return { padding: '6px 12px', borderRadius: 6, border: 'none', background: '#2F5597', color: 'white', fontSize: 13, cursor: 'pointer' };
  }
  return { padding: '6px 12px', borderRadius: 6, border: '1px solid #d7ddf0', background: 'white', color: '#2F5597', fontSize: 13, cursor: 'pointer' };
}

const styles: Record<string, React.CSSProperties> = {
  main: { fontFamily: 'system-ui, sans-serif', padding: 'clamp(1.25rem, 4vw, 2.5rem)', maxWidth: 1100, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' },
  title: { margin: 0, color: '#203864', fontSize: 26 },
  subtitle: { margin: '4px 0 0', color: '#6c6f76', fontSize: 13.5 },
  muted: { color: '#9aa0a8', fontSize: 13.5 },
  hint: { color: '#6c6f76', fontSize: 12, margin: '0 0 10px' },
  error: {
    color: '#DC3545', fontSize: 13.5, background: '#FBE9EA', border: '1px solid #f3c2c6',
    borderRadius: 6, padding: '0.5rem 0.75rem', marginBottom: 12,
  },
  section: { background: 'white', borderRadius: 10, padding: '1.25rem 1.5rem', border: '1px solid #e4e6ea' },
  search: {
    width: '100%', maxWidth: 420, padding: '7px 10px', borderRadius: 6, border: '1px solid #d0d4da',
    fontSize: 13, boxSizing: 'border-box', marginBottom: 14,
  },
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13.5 },
  th: {
    textAlign: 'left', borderBottom: '1px solid #e4e6ea', padding: '6px 8px', color: '#6c6f76',
    fontWeight: 600, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
  },
  sortArrow: { color: '#2F5597', fontSize: 11 },
  rowClickable: { cursor: 'pointer' },
  td: { borderBottom: '1px solid #f0f1f3', padding: '6px 8px', verticalAlign: 'top' },
  tenantSlug: { fontSize: 11.5, color: '#9aa0a8' },
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(20,30,60,0.35)', display: 'flex',
    alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '1rem',
  },
  modal: {
    background: 'white', borderRadius: 10, padding: '1.25rem', width: '100%', maxWidth: 420,
    boxSizing: 'border-box', maxHeight: '90vh', overflowY: 'auto',
  },
  h2: { fontSize: 16, color: '#203864', margin: '0 0 12px' },
  label: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#203864', marginBottom: 10, fontWeight: 600 },
  input: { padding: '7px 10px', borderRadius: 6, border: '1px solid #d0d4da', fontSize: 13.5, fontWeight: 400 },
};

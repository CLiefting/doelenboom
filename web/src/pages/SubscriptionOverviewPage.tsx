import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type { TenantSubscriptionOverviewRow } from '../types';

// Sorteerbaar abonnementenoverzicht, naast (niet i.p.v.) Tenantbeheer — zie
// GET /api/subscription-requests/overview / listTenantSubscriptionOverview in
// subscriptions.ts. Verzoek van Charles (30 augustus 2026): "welk abonnement
// bij de tenant hoort, tot wanneer, wie de aanvrager is en wat het email/tel
// nummer is ... kunnen sorteren op alle kolommen." Eén rij per tenant, ook
// tenants die niet via de zelfbedieningsaanvraag zijn ontstaan (dan blijven
// status/aanvrager/e-mail/telefoon leeg — "—").
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
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('tenantName');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  useEffect(() => {
    api.subscriptionOverview(token).then(setRows).catch((err) => setError(errMsg(err)));
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
          <p style={styles.subtitle}>Eén rij per tenant — klik op een kolomkop om te sorteren.</p>
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
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => {
                  const color = licenseBorderColor(r.licenseEndDate);
                  return (
                    <tr key={r.tenantId}>
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
                    </tr>
                  );
                })}
                {visibleRows.length === 0 && (
                  <tr>
                    <td style={styles.td} colSpan={COLUMNS.length}>
                      <span style={styles.muted}>Geen tenants gevonden.</span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
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
  td: { borderBottom: '1px solid #f0f1f3', padding: '6px 8px', verticalAlign: 'top' },
  tenantSlug: { fontSize: 11.5, color: '#9aa0a8' },
};

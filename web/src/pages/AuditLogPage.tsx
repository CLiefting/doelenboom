import { useEffect, useState } from 'react';
import LoginPage from './LoginPage';
import { api, ApiError } from '../api';
import { useSession } from '../useSession';
import type { AuditLogEntry } from '../types';

// Losse route (/audit-log, zie main.tsx) — zelfde opzet als SessionsPage:
// eigen login via useSession en alleen sysadmins mogen verder. Toont het
// generieke auditlogboek (db/init.sql audit_log): wie heeft welke boom
// bekeken met welke rechten, en welke tenant-instellingen zijn gewijzigd.
// Bewust GEEN verwijderknop: dit logboek is append-only, ook voor een
// sysadmin (zie Charles' expliciete eis).
export default function AuditLogPage() {
  const { session, setSession } = useSession();

  if (!session) {
    return <LoginPage onLoggedIn={(token, user) => setSession({ token, user })} />;
  }
  if (!session.user.isSysadmin) {
    return (
      <main style={styles.main}>
        <div style={styles.card}>
          <h1 style={styles.title}>Geen toegang</h1>
          <p style={{ color: '#6c6f76', fontSize: 14 }}>
            /audit-log is alleen voor sysadmins. Je bent ingelogd als {session.user.email}.
          </p>
          <a href="/" style={styles.link}>← Terug naar Doelenboom</a>
        </div>
      </main>
    );
  }
  return <AuditLogContent token={session.token} />;
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString('nl-NL');
}

function eventLabel(eventType: AuditLogEntry['eventType']): string {
  return eventType === 'doelenboom_view' ? 'Boom bekeken' : 'Tenant-instellingen gewijzigd';
}

function formatDetail(entry: AuditLogEntry): string {
  if (entry.eventType === 'tenant_settings_changed') {
    const changes = (entry.detail as { changes?: Record<string, { from: unknown; to: unknown }> }).changes ?? {};
    const parts = Object.entries(changes).map(([field, { from, to }]) => `${field}: ${JSON.stringify(from)} → ${JSON.stringify(to)}`);
    return parts.join(', ');
  }
  return '';
}

function AuditLogContent({ token }: { token: string }) {
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | AuditLogEntry['eventType']>('all');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  function load() {
    setError(null);
    api.auditLog(token).then(setEntries).catch((err) => {
      setError(err instanceof ApiError ? err.message : 'Kon auditlogboek niet laden.');
    });
  }

  useEffect(load, [token]);

  async function handleExport() {
    setExportError(null);
    setExporting(true);
    try {
      const { blob, filename } = await api.downloadAuditLogExport(token);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) {
      setExportError(err instanceof ApiError ? err.message : 'Export mislukt.');
    } finally {
      setExporting(false);
    }
  }

  const filtered = entries?.filter((e) => filter === 'all' || e.eventType === filter) ?? [];

  return (
    <main style={styles.mainWide}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={styles.title}>Auditlogboek</h1>
          <p style={{ color: '#6c6f76', fontSize: 13.5, margin: '4px 0 0' }}>
            Wie heeft welke boom bekeken (met welke rechten) en welke tenant-instellingen zijn gewijzigd — nieuwste eerst.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={styles.ghostButton}>↻ Vernieuwen</button>
          <button onClick={handleExport} disabled={exporting} style={styles.primaryButton}>
            {exporting ? 'Bezig…' : '⬇ Exporteer als Excel'}
          </button>
          <a href="/" style={{ ...styles.ghostButton, textDecoration: 'none', display: 'inline-block' }}>← Terug</a>
        </div>
      </header>

      {exportError && <p style={{ color: '#DC3545' }}>{exportError}</p>}

      {entries && entries.length > 0 && (
        <div style={styles.toggleGroup}>
          <button onClick={() => setFilter('all')} style={filter === 'all' ? styles.toggleBtnActive : styles.toggleBtn}>
            Alles
          </button>
          <button onClick={() => setFilter('doelenboom_view')} style={filter === 'doelenboom_view' ? styles.toggleBtnActive : styles.toggleBtn}>
            Boom bekeken
          </button>
          <button onClick={() => setFilter('tenant_settings_changed')} style={filter === 'tenant_settings_changed' ? styles.toggleBtnActive : styles.toggleBtn}>
            Tenant-instellingen
          </button>
        </div>
      )}

      {error && <p style={{ color: '#DC3545' }}>{error}</p>}
      {!entries && !error && <p>Laden…</p>}
      {entries && entries.length === 0 && <p style={{ color: '#9aa0a8', fontSize: 13 }}>Nog geen auditlogregels geregistreerd.</p>}

      {entries && filtered.length > 0 && (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Datum/tijd</th>
                <th style={styles.th}>Gebeurtenis</th>
                <th style={styles.th}>Gebruiker</th>
                <th style={styles.th}>Tenant</th>
                <th style={styles.th}>Doelenboom</th>
                <th style={styles.th}>Rol</th>
                <th style={styles.th}>Details</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.id}>
                  <td style={styles.td}>{formatTimestamp(e.createdAt)}</td>
                  <td style={styles.td}>{eventLabel(e.eventType)}</td>
                  <td style={styles.td}>{e.userEmail ?? '(verwijderd account)'}</td>
                  <td style={styles.td}>{e.tenantName ?? '(verwijderde tenant)'}</td>
                  <td style={styles.td}>{e.doelenboomName ?? '—'}</td>
                  <td style={styles.td}>{e.role ?? '—'}</td>
                  <td style={{ ...styles.td, fontSize: 12, color: '#6c6f76' }}>{formatDetail(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh',
    background: '#f4f5f7', fontFamily: 'system-ui, sans-serif',
  },
  card: {
    background: 'white', padding: 'clamp(1.5rem, 6vw, 2.5rem)', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    width: 'min(380px, 90vw)', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '0.75rem',
  },
  mainWide: { fontFamily: 'system-ui, sans-serif', padding: 'clamp(1rem, 4vw, 2rem)', maxWidth: 1100, margin: '0 auto' },
  title: { margin: 0, color: '#203864' },
  link: { color: '#2F5597', fontSize: 14 },
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13.5, background: 'white', borderRadius: 10, overflow: 'hidden', border: '1px solid #e4e6ea' },
  th: { textAlign: 'left', borderBottom: '1px solid #e4e6ea', padding: '8px 12px', color: '#6c6f76', fontWeight: 600 },
  td: { borderBottom: '1px solid #f0f1f3', padding: '8px 12px' },
  ghostButton: {
    borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: '1.5px solid #d0d4da', background: 'white', color: '#444',
  },
  primaryButton: {
    borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: 'none', background: '#2F5597', color: 'white',
  },
  toggleGroup: {
    display: 'inline-flex', gap: 2, marginBottom: 14, padding: 3,
    background: '#eef0f3', borderRadius: 10,
  },
  toggleBtn: {
    borderRadius: 8, padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: 'none', background: 'transparent', color: '#6c6f76',
  },
  toggleBtnActive: {
    borderRadius: 8, padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: 'none', background: 'white', color: '#203864', boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
  },
};

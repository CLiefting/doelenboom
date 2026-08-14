import { useEffect, useState } from 'react';
import LoginPage from './LoginPage';
import { api, ApiError } from '../api';
import { useSession } from '../useSession';
import type { DbStatTenant } from '../types';

// Losse route (/dbstat, zie main.tsx) i.p.v. een view binnen App.tsx — bewust
// bookmarkbaar/deelbaar als eigen URL. Regelt zijn eigen login (via dezelfde
// useSession-hook als App.tsx, dus geen dubbele login nodig als je al
// ingelogd bent) en laat alleen sysadmins verder — puur diagnostisch, om te
// controleren of het automatisch leegmaken van een tenant (tenantWipe.ts)
// daadwerkelijk werkt.
export default function DbStatPage() {
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
            /dbstat is alleen voor sysadmins. Je bent ingelogd als {session.user.email}.
          </p>
          <a href="/" style={styles.link}>← Terug naar Doelenboom</a>
        </div>
      </main>
    );
  }
  return <DbStatContent token={session.token} />;
}

function DbStatContent({ token }: { token: string }) {
  const [tenants, setTenants] = useState<DbStatTenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setError(null);
    api.dbStat(token).then(setTenants).catch((err) => {
      setError(err instanceof ApiError ? err.message : 'Kon database-overzicht niet laden.');
    });
  }

  useEffect(load, [token]);

  return (
    <main style={styles.mainWide}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={styles.title}>Database-overzicht</h1>
          <p style={{ color: '#6c6f76', fontSize: 13.5, margin: '4px 0 0' }}>
            Alle tenants met hun doelenbomen en aantallen — handig om te checken of een tenant écht leeg is.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={styles.ghostButton}>↻ Vernieuwen</button>
          <a href="/" style={{ ...styles.ghostButton, textDecoration: 'none', display: 'inline-block' }}>← Terug</a>
        </div>
      </header>

      {error && <p style={{ color: '#DC3545' }}>{error}</p>}
      {!tenants && !error && <p>Laden…</p>}

      {tenants && tenants.map((t) => (
        <section key={t.id} style={styles.section}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <h2 style={styles.h2}>{t.name} <span style={{ opacity: 0.5, fontWeight: 400 }}>({t.slug})</span></h2>
            {t.wipeOnEmpty && (
              <span style={styles.badge}>auto-leegmaken na {t.sessionTimeoutMinutes} min. inactiviteit</span>
            )}
          </div>

          {t.doelenbomen.length === 0 && <p style={{ color: '#9aa0a8', fontSize: 13 }}>Geen doelenbomen.</p>}

          {t.doelenbomen.length > 0 && (
            <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Doelenboom</th>
                  <th style={styles.th}>Elementen</th>
                  <th style={styles.th}>Relaties</th>
                  <th style={styles.th}>Tags</th>
                  <th style={styles.th}>Org.-onderdelen</th>
                  <th style={styles.th}>Imports</th>
                </tr>
              </thead>
              <tbody>
                {t.doelenbomen.map((d) => {
                  const empty = d.elementCount === 0 && d.edgeCount === 0 && d.tagCount === 0 && d.orgUnitCount === 0;
                  return (
                    <tr key={d.id}>
                      <td style={styles.td}>
                        {d.name} <span style={{ opacity: 0.5, fontSize: 12 }}>({d.slug})</span>
                        {empty && <span style={styles.emptyBadge}>leeg</span>}
                      </td>
                      <td style={styles.td}>{d.elementCount}</td>
                      <td style={styles.td}>{d.edgeCount}</td>
                      <td style={styles.td}>{d.tagCount}</td>
                      <td style={styles.td}>{d.orgUnitCount}</td>
                      <td style={styles.td}>{d.importCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          )}
        </section>
      ))}
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
  mainWide: { fontFamily: 'system-ui, sans-serif', padding: 'clamp(1rem, 4vw, 2rem)', maxWidth: 960, margin: '0 auto' },
  title: { margin: 0, color: '#203864' },
  link: { color: '#2F5597', fontSize: 14 },
  section: { marginBottom: '1.5rem', background: 'white', borderRadius: 10, padding: '1.25rem 1.5rem', border: '1px solid #e4e6ea' },
  h2: { fontSize: 15, margin: 0, color: '#203864' },
  badge: {
    fontSize: 11, color: '#946200', background: '#FFF3CD', border: '1px solid #FFE69C',
    borderRadius: 999, padding: '2px 8px',
  },
  emptyBadge: {
    marginLeft: 8, fontSize: 11, color: '#2e7d32', background: '#E8F5E9', border: '1px solid #C8E6C9',
    borderRadius: 999, padding: '2px 8px',
  },
  // overflowX:auto zodat een brede tabel op een smal scherm (telefoon) kan
  // scrollen i.p.v. de pagina-layout te breken.
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13.5 },
  th: { textAlign: 'left', borderBottom: '1px solid #e4e6ea', padding: '6px 8px', color: '#6c6f76', fontWeight: 600 },
  td: { borderBottom: '1px solid #f0f1f3', padding: '6px 8px' },
  ghostButton: {
    borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: '1.5px solid #d0d4da', background: 'white', color: '#444',
  },
};

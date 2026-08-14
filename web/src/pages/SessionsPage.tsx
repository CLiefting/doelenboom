import { useEffect, useMemo, useState } from 'react';
import LoginPage from './LoginPage';
import { api, ApiError } from '../api';
import { useSession } from '../useSession';
import type { SessionInfo } from '../types';

// Losse route (/sessions, zie main.tsx) i.p.v. een view binnen App.tsx —
// zelfde opzet als DbStatPage: eigen login via useSession (geen dubbele login
// nodig als je al ingelogd bent) en alleen sysadmins mogen verder. Toont wie er
// (recent) is ingelogd en wanneer, op basis van de sessions-tabel — puur
// inzicht, geen beheeracties hier (accounts beheer je via Gebruikersbeheer).
export default function SessionsPage() {
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
            /sessions is alleen voor sysadmins. Je bent ingelogd als {session.user.email}.
          </p>
          <a href="/" style={styles.link}>← Terug naar Doelenboom</a>
        </div>
      </main>
    );
  }
  return <SessionsContent token={session.token} />;
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString('nl-NL');
}

type UserAggregate = {
  userId: number;
  email: string;
  isSysadmin: boolean;
  firstLogin: string;
  lastLogin: string;
  totalLogins: number;
  activeNow: boolean;
};

// Groepeert de platte sessielijst (één rij per login, zie GET /api/sessions)
// per account: eerste login, laatste login en totaal aantal logins. Puur
// client-side afgeleid uit de al-opgehaalde sessies — geen apart endpoint
// nodig, en blijft vanzelf in sync met de "alles"-lijst hierboven.
function aggregateByUser(sessions: SessionInfo[]): UserAggregate[] {
  const byUser = new Map<number, UserAggregate>();
  for (const s of sessions) {
    const existing = byUser.get(s.userId);
    if (!existing) {
      byUser.set(s.userId, {
        userId: s.userId,
        email: s.email,
        isSysadmin: s.isSysadmin,
        firstLogin: s.createdAt,
        lastLogin: s.createdAt,
        totalLogins: 1,
        activeNow: s.active,
      });
    } else {
      if (s.createdAt < existing.firstLogin) existing.firstLogin = s.createdAt;
      if (s.createdAt > existing.lastLogin) existing.lastLogin = s.createdAt;
      existing.totalLogins += 1;
      existing.activeNow = existing.activeNow || s.active;
    }
  }
  return [...byUser.values()].sort((a, b) => (a.lastLogin < b.lastLogin ? 1 : -1));
}

function SessionsContent({ token }: { token: string }) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'sessions' | 'users'>('sessions');

  function load() {
    setError(null);
    api.sessions(token).then(setSessions).catch((err) => {
      setError(err instanceof ApiError ? err.message : 'Kon login-overzicht niet laden.');
    });
  }

  useEffect(load, [token]);

  const activeCount = sessions?.filter((s) => s.active).length ?? 0;
  const userAggregates = useMemo(() => (sessions ? aggregateByUser(sessions) : []), [sessions]);

  return (
    <main style={styles.mainWide}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={styles.title}>Login-overzicht</h1>
          <p style={{ color: '#6c6f76', fontSize: 13.5, margin: '4px 0 0' }}>
            Wie is ingelogd (geweest) en wanneer — alle sessies, nieuwste eerst.
            {sessions && <> <strong>{sessions.length}</strong> totaal, <strong>{activeCount}</strong> nu actief.</>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={styles.ghostButton}>↻ Vernieuwen</button>
          <a href="/" style={{ ...styles.ghostButton, textDecoration: 'none', display: 'inline-block' }}>← Terug</a>
        </div>
      </header>

      {sessions && sessions.length > 0 && (
        <div style={styles.toggleGroup}>
          <button
            onClick={() => setViewMode('sessions')}
            style={viewMode === 'sessions' ? styles.toggleBtnActive : styles.toggleBtn}
          >
            Per login
          </button>
          <button
            onClick={() => setViewMode('users')}
            style={viewMode === 'users' ? styles.toggleBtnActive : styles.toggleBtn}
          >
            Per gebruiker
          </button>
        </div>
      )}

      {error && <p style={{ color: '#DC3545' }}>{error}</p>}
      {!sessions && !error && <p>Laden…</p>}
      {sessions && sessions.length === 0 && <p style={{ color: '#9aa0a8', fontSize: 13 }}>Nog geen sessies geregistreerd.</p>}

      {sessions && sessions.length > 0 && viewMode === 'sessions' && (
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Account</th>
              <th style={styles.th}>Ingelogd op</th>
              <th style={styles.th}>Laatst gezien</th>
              <th style={styles.th}>Uitgelogd op</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.sessionId}>
                <td style={styles.td}>
                  {s.active ? (
                    <span style={styles.activeBadge}>actief</span>
                  ) : (
                    <span style={styles.inactiveBadge}>{s.endedAt ? 'uitgelogd' : 'verlopen'}</span>
                  )}
                </td>
                <td style={styles.td}>
                  {s.email}
                  {s.isSysadmin && <span style={styles.sysadminBadge}>sysadmin</span>}
                </td>
                <td style={styles.td}>{formatTimestamp(s.createdAt)}</td>
                <td style={styles.td}>{formatTimestamp(s.lastSeenAt)}</td>
                <td style={styles.td}>{s.endedAt ? formatTimestamp(s.endedAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {sessions && sessions.length > 0 && viewMode === 'users' && (
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Account</th>
              <th style={styles.th}>Eerste login</th>
              <th style={styles.th}>Laatste login</th>
              <th style={styles.th}>Totaal aantal logins</th>
            </tr>
          </thead>
          <tbody>
            {userAggregates.map((u) => (
              <tr key={u.userId}>
                <td style={styles.td}>
                  {u.activeNow ? (
                    <span style={styles.activeBadge}>actief</span>
                  ) : (
                    <span style={styles.inactiveBadge}>niet actief</span>
                  )}
                </td>
                <td style={styles.td}>
                  {u.email}
                  {u.isSysadmin && <span style={styles.sysadminBadge}>sysadmin</span>}
                </td>
                <td style={styles.td}>{formatTimestamp(u.firstLogin)}</td>
                <td style={styles.td}>{formatTimestamp(u.lastLogin)}</td>
                <td style={styles.td}>{u.totalLogins}</td>
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
  mainWide: { fontFamily: 'system-ui, sans-serif', padding: 'clamp(1rem, 4vw, 2rem)', maxWidth: 960, margin: '0 auto' },
  title: { margin: 0, color: '#203864' },
  link: { color: '#2F5597', fontSize: 14 },
  // overflowX:auto zodat een brede tabel op een smal scherm (telefoon) kan
  // scrollen i.p.v. de pagina-layout te breken.
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13.5, background: 'white', borderRadius: 10, overflow: 'hidden', border: '1px solid #e4e6ea' },
  th: { textAlign: 'left', borderBottom: '1px solid #e4e6ea', padding: '8px 12px', color: '#6c6f76', fontWeight: 600 },
  td: { borderBottom: '1px solid #f0f1f3', padding: '8px 12px' },
  activeBadge: {
    fontSize: 11, color: '#2e7d32', background: '#E8F5E9', border: '1px solid #C8E6C9',
    borderRadius: 999, padding: '2px 8px',
  },
  inactiveBadge: {
    fontSize: 11, color: '#6c6f76', background: '#f0f1f3', border: '1px solid #e4e6ea',
    borderRadius: 999, padding: '2px 8px',
  },
  sysadminBadge: {
    marginLeft: 8, fontSize: 11, color: '#946200', background: '#FFF3CD', border: '1px solid #FFE69C',
    borderRadius: 999, padding: '2px 8px',
  },
  ghostButton: {
    borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: '1.5px solid #d0d4da', background: 'white', color: '#444',
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

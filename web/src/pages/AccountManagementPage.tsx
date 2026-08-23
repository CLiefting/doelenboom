import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { User, UserSummary } from '../types';

// Accountbeheer — sysadmin-only: globale lijst van alle accounts (los van
// tenants). Hier kan een sysadmin een account aanmaken, de sysadmin-vlag
// zetten, het wachtwoord resetten, of een account verwijderen. Voor het
// beheren van tenants, doelenbomen en tenant-leden zie TenantManagementPage.
export default function AccountManagementPage({
  token,
  user,
  onBack,
}: {
  token: string;
  user: User;
  onBack: () => void;
}) {
  const [allUsers, setAllUsers] = useState<UserSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.users(token).then(setAllUsers).catch((err) => setError(errMsg(err)));
  }, [token]);

  function refreshUsers() {
    api.users(token).then(setAllUsers).catch((err) => setError(errMsg(err)));
  }

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Accountbeheer</h1>
          <p style={styles.subtitle}>Sysadmin — alle accounts, los van tenants.</p>
        </div>
        <button onClick={onBack} style={btnStyle('ghost')}>← Terug</button>
      </header>

      {error && <p style={styles.error}>{error}</p>}

      <section style={styles.section}>
        <h2 style={styles.h2}>Alle accounts</h2>
        {!allUsers && <p>Laden…</p>}
        {allUsers && (
          <AllUsersTable
            token={token}
            users={allUsers}
            currentUserId={user.id}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            onChanged={refreshUsers}
          />
        )}
        <CreateUserForm
          token={token}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          onCreated={refreshUsers}
        />
      </section>
    </main>
  );
}

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Er ging iets mis.';
}

function AllUsersTable({
  token,
  users,
  currentUserId,
  busy,
  setBusy,
  setError,
  onChanged,
}: {
  token: string;
  users: UserSummary[];
  currentUserId: number;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onChanged: () => void;
}) {
  async function toggleSysadmin(u: UserSummary) {
    setBusy(true);
    setError(null);
    try {
      await api.updateUser(token, u.id, { isSysadmin: !u.is_sysadmin });
      onChanged();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(u: UserSummary) {
    if (!window.confirm(`Account "${u.email}" volledig verwijderen? Dit kan niet ongedaan worden gemaakt.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteUser(token, u.id);
      onChanged();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  const [resettingId, setResettingId] = useState<number | null>(null);

  return (
    <div style={styles.tableWrap}>
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.th}>E-mail</th>
          <th style={styles.th}>Sysadmin</th>
          <th style={styles.th}>Tenants</th>
          <th style={styles.th}></th>
        </tr>
      </thead>
      <tbody>
        {users.map((u) => (
          <tr key={u.id}>
            <td style={styles.td}>
              {u.email}
              {u.must_change_password && (
                <span style={styles.mustChangeBadge} title="Moet wachtwoord wijzigen bij volgende login">
                  moet wachtwoord wijzigen
                </span>
              )}
            </td>
            <td style={styles.td}>
              <input
                type="checkbox"
                checked={u.is_sysadmin}
                disabled={busy}
                onChange={() => toggleSysadmin(u)}
              />
            </td>
            <td style={styles.td}>
              {u.tenantRoles.length === 0
                ? <span style={styles.muted}>—</span>
                : u.tenantRoles.map((r) => `${r.tenantName} (${r.role})`).join(', ')}
            </td>
            <td style={styles.td}>
              <button
                disabled={busy}
                onClick={() => setResettingId(resettingId === u.id ? null : u.id)}
                style={btnStyle('ghost')}
              >
                Wachtwoord resetten
              </button>
              <button
                disabled={busy || u.id === currentUserId}
                onClick={() => remove(u)}
                style={btnStyle('danger-text')}
                title={u.id === currentUserId ? 'Je kunt je eigen account hier niet verwijderen' : ''}
              >
                Verwijderen
              </button>
              {resettingId === u.id && (
                <ResetPasswordRow
                  token={token}
                  userId={u.id}
                  busy={busy}
                  setBusy={setBusy}
                  setError={setError}
                  onDone={() => {
                    setResettingId(null);
                    onChanged();
                  }}
                />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

function ResetPasswordRow({
  token,
  userId,
  busy,
  setBusy,
  setError,
  onDone,
}: {
  token: string;
  userId: number;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // mustChangePassword niet meegeven = standaard true (zie users.ts): de
      // gebruiker moet dit tijdelijke wachtwoord bij de eerstvolgende login
      // vervangen door een eigen wachtwoord.
      await api.updateUser(token, userId, { password });
      setPassword('');
      onDone();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
      <input
        style={styles.input}
        type="password"
        placeholder="nieuw tijdelijk wachtwoord (min. 8 tekens)"
        required
        minLength={8}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus
      />
      <button style={btnStyle('primary')} type="submit" disabled={busy}>
        Opslaan
      </button>
    </form>
  );
}

function CreateUserForm({
  token,
  busy,
  setBusy,
  setError,
  onCreated,
}: {
  token: string;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onCreated: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSysadmin, setIsSysadmin] = useState(false);
  const [mustChangePassword, setMustChangePassword] = useState(true);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createUser(token, { email, password, isSysadmin, mustChangePassword });
      setEmail('');
      setPassword('');
      setIsSysadmin(false);
      setMustChangePassword(true);
      onCreated();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={styles.inlineForm}>
      <input
        style={styles.input}
        type="email"
        placeholder="e-mail"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        style={styles.input}
        type="password"
        placeholder="wachtwoord (min. 8 tekens)"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
        <input type="checkbox" checked={isSysadmin} onChange={(e) => setIsSysadmin(e.target.checked)} />
        sysadmin
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
        <input
          type="checkbox"
          checked={mustChangePassword}
          onChange={(e) => setMustChangePassword(e.target.checked)}
        />
        moet wachtwoord wijzigen bij volgende login
      </label>
      <button style={btnStyle('primary')} type="submit" disabled={busy}>
        + Account aanmaken
      </button>
    </form>
  );
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
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' },
  title: { margin: 0, color: '#203864' },
  subtitle: { margin: '4px 0 0', color: '#6c6f76', fontSize: 13.5 },
  section: { marginBottom: '2rem', background: 'white', borderRadius: 10, padding: '1.25rem 1.5rem', border: '1px solid #e4e6ea' },
  h2: { fontSize: 15, margin: '0 0 12px', color: '#203864' },
  inlineForm: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 12 },
  input: { padding: '7px 10px', borderRadius: 6, border: '1px solid #d0d4da', fontSize: 13 },
  // overflowX:auto zodat een brede tabel op een smal scherm (telefoon) kan
  // scrollen i.p.v. de pagina-layout te breken.
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13.5 },
  th: { textAlign: 'left', borderBottom: '1px solid #e4e6ea', padding: '6px 8px', color: '#6c6f76', fontWeight: 600 },
  td: { borderBottom: '1px solid #f0f1f3', padding: '6px 8px' },
  muted: { color: '#9aa0a8', fontSize: 13, margin: 0 },
  error: { color: '#DC3545', fontSize: 13 },
  mustChangeBadge: {
    marginLeft: 8, fontSize: 11, color: '#946200', background: '#FFF3CD',
    border: '1px solid #FFE69C', borderRadius: 999, padding: '2px 8px',
  },
};

import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { TenantMember, TenantRoleName, TenantSummary, User, UserSummary } from '../types';

// Gebruikersbeheer — twee gedaantes in één scherm, afhankelijk van de rol van de
// ingelogde gebruiker:
// - sysadmin: ziet alle tenants (kan nieuwe aanmaken) en alle accounts (kan
//   nieuwe aanmaken, sysadmin-vlag zetten, verwijderen), en kan leden van elke
//   tenant beheren.
// - tenant-admin (niet-sysadmin met role='admin' in minstens één tenant): ziet
//   alleen de tenant(s) waar hij/zij admin van is, kan daar leden toevoegen/
//   wijzigen/verwijderen (en desgewenst een nieuw account aanmaken via die
//   route) — geen tenant-aanmaak, geen zicht op andere tenants of accounts.
export default function UserManagementPage({
  token,
  user,
  onBack,
}: {
  token: string;
  user: User;
  onBack: () => void;
}) {
  const [tenants, setTenants] = useState<TenantSummary[] | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState<number | null>(null);
  const [members, setMembers] = useState<TenantMember[] | null>(null);
  const [allUsers, setAllUsers] = useState<UserSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const manageableTenants = (tenants ?? []).filter((t) => user.isSysadmin || t.my_role === 'admin');

  useEffect(() => {
    api.tenants(token).then(setTenants).catch((err) => setError(errMsg(err)));
    if (user.isSysadmin) {
      api.users(token).then(setAllUsers).catch((err) => setError(errMsg(err)));
    }
  }, [token, user.isSysadmin]);

  useEffect(() => {
    if (selectedTenantId == null) {
      setMembers(null);
      return;
    }
    api.tenantMembers(token, selectedTenantId).then(setMembers).catch((err) => setError(errMsg(err)));
  }, [token, selectedTenantId]);

  function refreshMembers() {
    if (selectedTenantId == null) return;
    api.tenantMembers(token, selectedTenantId).then(setMembers).catch((err) => setError(errMsg(err)));
  }

  function refreshUsers() {
    if (!user.isSysadmin) return;
    api.users(token).then(setAllUsers).catch((err) => setError(errMsg(err)));
  }

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Gebruikersbeheer</h1>
          <p style={styles.subtitle}>
            {user.isSysadmin ? 'Sysadmin — alle tenants en accounts.' : 'Leden beheren van jouw tenant(s).'}
          </p>
        </div>
        <button onClick={onBack} style={btnStyle('ghost')}>← Terug</button>
      </header>

      {error && <p style={styles.error}>{error}</p>}

      <section style={styles.section}>
        <h2 style={styles.h2}>Tenants</h2>
        {!tenants && <p>Laden…</p>}
        {tenants && manageableTenants.length === 0 && <p style={styles.muted}>Geen tenants om te beheren.</p>}
        <div style={styles.tenantList}>
          {manageableTenants.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelectedTenantId(t.id)}
              style={{
                ...btnStyle(selectedTenantId === t.id ? 'primary' : 'ghost'),
                textAlign: 'left',
              }}
            >
              {t.name} <span style={{ opacity: 0.6, fontSize: 12 }}>({t.slug})</span>
            </button>
          ))}
        </div>
        {user.isSysadmin && (
          <CreateTenantForm
            token={token}
            onCreated={() => {
              api.tenants(token).then(setTenants).catch((err) => setError(errMsg(err)));
            }}
          />
        )}
      </section>

      {selectedTenantId != null && (
        <section style={styles.section}>
          <h2 style={styles.h2}>
            Leden van {manageableTenants.find((t) => t.id === selectedTenantId)?.name ?? ''}
          </h2>
          {!members && <p>Laden…</p>}
          {members && (
            <MemberTable
              token={token}
              tenantId={selectedTenantId}
              members={members}
              busy={busy}
              setBusy={setBusy}
              setError={setError}
              onChanged={refreshMembers}
            />
          )}
          <AddMemberForm
            token={token}
            tenantId={selectedTenantId}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            onAdded={refreshMembers}
          />
        </section>
      )}

      {user.isSysadmin && (
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
      )}
    </main>
  );
}

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Er ging iets mis.';
}

function MemberTable({
  token,
  tenantId,
  members,
  busy,
  setBusy,
  setError,
  onChanged,
}: {
  token: string;
  tenantId: number;
  members: TenantMember[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onChanged: () => void;
}) {
  async function changeRole(userId: number, role: TenantRoleName) {
    setBusy(true);
    setError(null);
    try {
      await api.updateTenantMemberRole(token, tenantId, userId, role);
      onChanged();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: number, email: string) {
    if (!window.confirm(`"${email}" verwijderen uit deze tenant?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.removeTenantMember(token, tenantId, userId);
      onChanged();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  if (members.length === 0) return <p style={styles.muted}>Nog geen leden.</p>;

  return (
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.th}>E-mail</th>
          <th style={styles.th}>Rol</th>
          <th style={styles.th}></th>
        </tr>
      </thead>
      <tbody>
        {members.map((m) => (
          <tr key={m.user_id}>
            <td style={styles.td}>{m.email}</td>
            <td style={styles.td}>
              <select
                value={m.role}
                disabled={busy}
                onChange={(e) => changeRole(m.user_id, e.target.value as TenantRoleName)}
                style={styles.select}
              >
                <option value="admin">admin</option>
                <option value="gebruiker">gebruiker</option>
              </select>
            </td>
            <td style={styles.td}>
              <button disabled={busy} onClick={() => remove(m.user_id, m.email)} style={btnStyle('danger-text')}>
                Verwijderen
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AddMemberForm({
  token,
  tenantId,
  busy,
  setBusy,
  setError,
  onAdded,
}: {
  token: string;
  tenantId: number;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onAdded: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<TenantRoleName>('gebruiker');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.addTenantMember(token, tenantId, { email, password: password || undefined, role });
      setEmail('');
      setPassword('');
      setRole('gebruiker');
      onAdded();
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
        placeholder="wachtwoord (alleen bij nieuw account)"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <select style={styles.select} value={role} onChange={(e) => setRole(e.target.value as TenantRoleName)}>
        <option value="admin">admin</option>
        <option value="gebruiker">gebruiker</option>
      </select>
      <button style={btnStyle('primary')} type="submit" disabled={busy}>
        + Lid toevoegen
      </button>
    </form>
  );
}

function CreateTenantForm({ token, onCreated }: { token: string; onCreated: () => void }) {
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createTenant(token, slug, name);
      setSlug('');
      setName('');
      onCreated();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={styles.inlineForm}>
      <input style={styles.input} placeholder="slug" required value={slug} onChange={(e) => setSlug(e.target.value)} />
      <input style={styles.input} placeholder="naam" required value={name} onChange={(e) => setName(e.target.value)} />
      <button style={btnStyle('primary')} type="submit" disabled={busy}>
        + Tenant aanmaken
      </button>
      {error && <span style={styles.error}>{error}</span>}
    </form>
  );
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

  return (
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
            <td style={styles.td}>{u.email}</td>
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
                disabled={busy || u.id === currentUserId}
                onClick={() => remove(u)}
                style={btnStyle('danger-text')}
                title={u.id === currentUserId ? 'Je kunt je eigen account hier niet verwijderen' : ''}
              >
                Verwijderen
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createUser(token, { email, password, isSysadmin });
      setEmail('');
      setPassword('');
      setIsSysadmin(false);
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
  main: { fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 860, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' },
  title: { margin: 0, color: '#203864' },
  subtitle: { margin: '4px 0 0', color: '#6c6f76', fontSize: 13.5 },
  section: { marginBottom: '2rem', background: 'white', borderRadius: 10, padding: '1.25rem 1.5rem', border: '1px solid #e4e6ea' },
  h2: { fontSize: 15, margin: '0 0 12px', color: '#203864' },
  tenantList: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  inlineForm: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 12 },
  input: { padding: '7px 10px', borderRadius: 6, border: '1px solid #d0d4da', fontSize: 13 },
  select: { padding: '6px 8px', borderRadius: 6, border: '1px solid #d0d4da', fontSize: 13 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13.5 },
  th: { textAlign: 'left', borderBottom: '1px solid #e4e6ea', padding: '6px 8px', color: '#6c6f76', fontWeight: 600 },
  td: { borderBottom: '1px solid #f0f1f3', padding: '6px 8px' },
  muted: { color: '#9aa0a8', fontSize: 13, margin: 0 },
  error: { color: '#DC3545', fontSize: 13 },
};

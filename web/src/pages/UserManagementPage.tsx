import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { DoelenboomSummary, TenantMember, TenantRoleName, TenantSummary, User, UserSummary } from '../types';

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
  const [doelenbomen, setDoelenbomen] = useState<DoelenboomSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const manageableTenants = (tenants ?? []).filter((t) => user.isSysadmin || t.my_role === 'admin');

  useEffect(() => {
    api.tenants(token).then(setTenants).catch((err) => setError(errMsg(err)));
    // GET /api/doelenbomen is voor iedere ingelogde gebruiker toegankelijk en
    // geeft (voor een tenant-admin) al alleen de doelenbomen van diens eigen
    // tenant(s) terug — geen aparte per-tenant call nodig, gewoon hieronder
    // client-side filteren op de geselecteerde tenant.
    api.doelenbomen(token).then(setDoelenbomen).catch((err) => setError(errMsg(err)));
    if (user.isSysadmin) {
      api.users(token).then(setAllUsers).catch((err) => setError(errMsg(err)));
    }
  }, [token, user.isSysadmin]);

  function refreshDoelenbomen() {
    api.doelenbomen(token).then(setDoelenbomen).catch((err) => setError(errMsg(err)));
  }

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
        {tenants && manageableTenants.length > 0 && (
          <p style={styles.muted}>Klik op een tenant om de leden (rol admin/gebruiker) te beheren.</p>
        )}
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
            Instellingen van {manageableTenants.find((t) => t.id === selectedTenantId)?.name ?? ''}
          </h2>
          {(() => {
            const t = manageableTenants.find((x) => x.id === selectedTenantId);
            if (!t) return null;
            return (
              <TenantSettingsForm
                token={token}
                tenant={t}
                busy={busy}
                setBusy={setBusy}
                setError={setError}
                onSaved={() => {
                  api.tenants(token).then(setTenants).catch((err) => setError(errMsg(err)));
                }}
              />
            );
          })()}
        </section>
      )}

      {selectedTenantId != null && (
        <section style={styles.section}>
          <h2 style={styles.h2}>
            Doelenbomen van {manageableTenants.find((t) => t.id === selectedTenantId)?.name ?? ''}
          </h2>
          {!doelenbomen && <p>Laden…</p>}
          {doelenbomen && (
            <DoelenbomenSection
              token={token}
              tenantId={selectedTenantId}
              doelenbomen={doelenbomen.filter((d) => d.tenant_id === selectedTenantId)}
              busy={busy}
              setBusy={setBusy}
              setError={setError}
              onChanged={refreshDoelenbomen}
            />
          )}
        </section>
      )}

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
    <div style={styles.tableWrap}>
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
    </div>
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

// Doelenbomen van een tenant beheren: aanmaken, hernoemen/slug wijzigen,
// alleen-lezen aan/uit zetten, verwijderen. Zelfde rechten als "Instellingen"
// hierboven (sysadmin of tenant-admin van déze tenant) — de API (rbac.ts)
// handhaaft dit sowieso, dit scherm toont het gewoon aan iedereen die de
// tenant al mag beheren. Verwijderen is destructief (cascade: alle
// elementen/relaties/tags/organisatieonderdelen/imports van die doelenboom
// gaan mee weg) — vandaar de expliciete window.confirm met die waarschuwing.
function DoelenbomenSection({
  token,
  tenantId,
  doelenbomen,
  busy,
  setBusy,
  setError,
  onChanged,
}: {
  token: string;
  tenantId: number;
  doelenbomen: DoelenboomSummary[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onChanged: () => void;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);

  async function remove(d: DoelenboomSummary) {
    const ok = window.confirm(
      `Doelenboom "${d.name}" volledig verwijderen? Alle elementen, relaties, tags, organisatieonderdelen en ` +
      `imports hierin gaan dan ook verloren. Dit kan niet ongedaan worden gemaakt.`
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteDoelenboom(token, d.id);
      onChanged();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {doelenbomen.length === 0 && <p style={styles.muted}>Nog geen doelenbomen in deze tenant.</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
        {doelenbomen.map((d) =>
          editingId === d.id ? (
            <DoelenboomEditRow
              key={d.id}
              token={token}
              doelenboom={d}
              busy={busy}
              setBusy={setBusy}
              setError={setError}
              onSaved={() => {
                setEditingId(null);
                onChanged();
              }}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <div key={d.id} style={styles.doelenboomRow}>
              <div>
                <strong>{d.name}</strong> <span style={{ opacity: 0.6, fontSize: 12 }}>({d.slug})</span>
                {d.read_only && <span style={styles.mustChangeBadge}>alleen-lezen</span>}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button disabled={busy} onClick={() => setEditingId(d.id)} style={btnStyle('ghost')}>
                  Bewerken
                </button>
                <button disabled={busy} onClick={() => remove(d)} style={btnStyle('danger-text')}>
                  Verwijderen
                </button>
              </div>
            </div>
          )
        )}
      </div>
      <CreateDoelenboomForm
        token={token}
        tenantId={tenantId}
        busy={busy}
        setBusy={setBusy}
        setError={setError}
        onCreated={onChanged}
      />
    </div>
  );
}

function DoelenboomEditRow({
  token,
  doelenboom,
  busy,
  setBusy,
  setError,
  onSaved,
  onCancel,
}: {
  token: string;
  doelenboom: DoelenboomSummary;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(doelenboom.name);
  const [slug, setSlug] = useState(doelenboom.slug);
  const [readOnly, setReadOnly] = useState(doelenboom.read_only);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateDoelenboom(token, doelenboom.id, { name, slug, readOnly });
      onSaved();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={styles.doelenboomEditRow}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="naam" required />
        <input style={styles.input} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="slug" required />
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
        <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
        Alleen-lezen — niemand behalve een sysadmin kan dan nog iets wijzigen
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
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

function CreateDoelenboomForm({
  token,
  tenantId,
  busy,
  setBusy,
  setError,
  onCreated,
}: {
  token: string;
  tenantId: number;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onCreated: () => void;
}) {
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createDoelenboom(token, tenantId, { slug, name });
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
        + Doelenboom aanmaken
      </button>
    </form>
  );
}

// Instelt of de data van deze tenant automatisch geleegd wordt zodra niemand
// er meer actief toegang toe heeft, en na hoeveel minuten inactiviteit dat
// telt — zie tenantWipe.ts / "Sessies & automatisch leegmaken" in de README.
// Alleen de doelenboom-data verdwijnt dan (tenant/doelenboom-rijen blijven
// bestaan); wijzigt hier niets aan de leden/rollen.
function TenantSettingsForm({
  token,
  tenant,
  busy,
  setBusy,
  setError,
  onSaved,
}: {
  token: string;
  tenant: TenantSummary;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onSaved: () => void;
}) {
  const [wipeOnEmpty, setWipeOnEmpty] = useState(tenant.wipe_on_empty);
  const [timeoutMinutes, setTimeoutMinutes] = useState(String(tenant.session_timeout_minutes));
  const [saved, setSaved] = useState(false);

  // Als de gebruiker een andere tenant selecteert moet het formulier de
  // waarden van díe tenant tonen, niet de vorige selectie blijven vasthouden.
  useEffect(() => {
    setWipeOnEmpty(tenant.wipe_on_empty);
    setTimeoutMinutes(String(tenant.session_timeout_minutes));
    setSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant.id]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const minutes = Number(timeoutMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      setError('Aantal minuten moet een positief getal zijn.');
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.updateTenantSettings(token, tenant.id, { wipeOnEmpty, sessionTimeoutMinutes: minutes });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
        <input type="checkbox" checked={wipeOnEmpty} onChange={(e) => setWipeOnEmpty(e.target.checked)} />
        Database van deze tenant automatisch leegmaken zodra niemand meer actief toegang heeft
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
        Na
        <input
          style={{ ...styles.input, width: 70 }}
          type="number"
          min={1}
          value={timeoutMinutes}
          onChange={(e) => setTimeoutMinutes(e.target.value)}
        />
        minuten inactiviteit
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button style={{ ...btnStyle('primary'), alignSelf: 'flex-start' }} type="submit" disabled={busy}>
          Opslaan
        </button>
        {saved && <span style={{ color: '#2e7d32', fontSize: 12.5 }}>Opgeslagen.</span>}
      </div>
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
  tenantList: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  inlineForm: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 12 },
  input: { padding: '7px 10px', borderRadius: 6, border: '1px solid #d0d4da', fontSize: 13 },
  select: { padding: '6px 8px', borderRadius: 6, border: '1px solid #d0d4da', fontSize: 13 },
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
  doelenboomRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8,
    padding: '8px 10px', borderRadius: 8, background: '#f7f8fa', border: '1px solid #e4e6ea',
  },
  doelenboomEditRow: {
    display: 'flex', flexDirection: 'column', gap: 10,
    padding: '10px 12px', borderRadius: 8, background: '#f7f8fa', border: '1px solid #e4e6ea',
  },
};

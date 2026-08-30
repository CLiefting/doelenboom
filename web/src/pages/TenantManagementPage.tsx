import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import ColumnConfigEditor from '../components/ColumnConfigEditor';
import TenantLicensePanel from '../components/TenantLicensePanel';
import type {
  DoelenboomMemberRole,
  DoelenboomSummary,
  DoelenboomTemplateSummary,
  TenantMember,
  TenantRoleName,
  TenantSummary,
  User,
} from '../types';

// Tenantbeheer — twee gedaantes in één scherm, afhankelijk van de rol van de
// ingelogde gebruiker:
// - sysadmin: ziet alle tenants (kan nieuwe aanmaken), kan tenants verwijderen,
//   standaardkolommen instellen, en kan doelenbomen + leden van elke tenant
//   beheren.
// - tenant-admin (niet-sysadmin met role='admin' in minstens één tenant): ziet
//   alleen de tenant(s) waar hij/zij admin van is, kan daar doelenbomen en
//   leden beheren — geen tenant-aanmaak/verwijdering, geen standaardkolommen,
//   geen zicht op andere tenants.
// Let op: dit scherm gaat NIET over globale accounts (zie AccountManagementPage,
// sysadmin-only) — "Leden" hier voegt iemand alleen toe aan déze tenant.
export default function TenantManagementPage({
  token,
  user,
  onBack,
  onSubscriptionOverviewRequest,
}: {
  token: string;
  user: User;
  onBack: () => void;
  // Sysadmin-only: link naar het sorteerbare abonnementenoverzicht (per
  // tenant tier/verloopdatum/aanvrager/e-mail/telefoon), zie
  // SubscriptionOverviewPage.tsx. Optioneel omdat deze pagina ook door een
  // niet-sysadmin tenant-admin gebruikt wordt, die dat overzicht niet mag zien.
  onSubscriptionOverviewRequest?: () => void;
}) {
  const [tenants, setTenants] = useState<TenantSummary[] | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState<number | null>(null);
  const [members, setMembers] = useState<TenantMember[] | null>(null);
  const [doelenbomen, setDoelenbomen] = useState<DoelenboomSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Zoeken op naam/slug — zelfde soort zoekbalk als in een doelenboom zelf
  // (tree.html), alleen hier client-side over de al opgehaalde tenantlijst
  // i.p.v. tegen de server (die is voor een sysadmin met veel tenants nooit
  // groot genoeg om dat de moeite waard te maken).
  const [tenantQuery, setTenantQuery] = useState('');

  const manageableTenants = (tenants ?? []).filter((t) => user.isSysadmin || t.my_role === 'admin');
  const visibleTenants = (() => {
    const q = tenantQuery.trim().toLowerCase();
    if (!q) return manageableTenants;
    return manageableTenants.filter((t) => t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q));
  })();

  useEffect(() => {
    api.tenants(token).then(setTenants).catch((err) => setError(errMsg(err)));
    // GET /api/doelenbomen is voor iedere ingelogde gebruiker toegankelijk en
    // geeft (voor een tenant-admin) al alleen de doelenbomen van diens eigen
    // tenant(s) terug — geen aparte per-tenant call nodig, gewoon hieronder
    // client-side filteren op de geselecteerde tenant.
    api.doelenbomen(token).then(setDoelenbomen).catch((err) => setError(errMsg(err)));
  }, [token]);

  function refreshDoelenbomen() {
    api.doelenbomen(token).then(setDoelenbomen).catch((err) => setError(errMsg(err)));
  }

  // Een tenant-admin beheert vrijwel altijd precies één tenant — die dan
  // meteen selecteren scheelt een overbodige extra klik, en zorgt dat de
  // "eerste doelenboom aanmaken"-melding (zie firstTreeCallout hieronder)
  // direct zichtbaar is i.p.v. achter een handmatige tenant-keuze.
  useEffect(() => {
    if (selectedTenantId == null && manageableTenants.length === 1) {
      setSelectedTenantId(manageableTenants[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manageableTenants.length]);

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

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Tenantbeheer</h1>
          <p style={styles.subtitle}>
            {user.isSysadmin ? 'Sysadmin — alle tenants.' : 'Tenant(s), doelenbomen en leden beheren.'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {user.isSysadmin && onSubscriptionOverviewRequest && (
            <button onClick={onSubscriptionOverviewRequest} style={btnStyle('ghost')}>Abonnementenoverzicht</button>
          )}
          <button onClick={onBack} style={btnStyle('ghost')}>← Terug</button>
        </div>
      </header>

      {error && <p style={styles.error}>{error}</p>}

      <section style={styles.section}>
        <h2 style={styles.h2}>Tenants</h2>
        {!tenants && <p>Laden…</p>}
        {tenants && manageableTenants.length === 0 && <p style={styles.muted}>Geen tenants om te beheren.</p>}
        {tenants && manageableTenants.length > 0 && (
          <>
            <p style={styles.muted}>Klik op een tenant om de leden (rol admin/gebruiker/bezoeker) te beheren.</p>
            <div style={styles.tenantSearchWrap}>
              <input
                type="text"
                value={tenantQuery}
                onChange={(e) => setTenantQuery(e.target.value)}
                placeholder="Zoek op naam of slug…"
                autoComplete="off"
                style={styles.tenantSearchInput}
              />
              {tenantQuery && (
                <button
                  type="button"
                  onClick={() => setTenantQuery('')}
                  title="Wis zoekopdracht"
                  aria-label="Wis zoekopdracht"
                  style={styles.tenantSearchClear}
                >
                  ×
                </button>
              )}
            </div>
            {visibleTenants.length === 0 && (
              <p style={styles.muted}>Geen tenants gevonden voor "{tenantQuery}".</p>
            )}
          </>
        )}
        <div style={styles.tenantList}>
          {visibleTenants.map((t) => {
            const licenseBorder = licenseBorderColor(t.license_end_date);
            return (
              <button
                key={t.id}
                onClick={() => setSelectedTenantId(t.id)}
                style={{
                  ...btnStyle(selectedTenantId === t.id ? 'primary' : 'ghost'),
                  textAlign: 'left',
                  ...(licenseBorder ? { borderColor: licenseBorder, borderWidth: 2 } : {}),
                }}
                title={licenseBorderTitle(t.license_end_date)}
              >
                {t.name} <span style={{ opacity: 0.6, fontSize: 12 }}>({t.slug})</span>
                {t.open_access_role && (
                  <span
                    style={{ marginLeft: 6, fontSize: 11, opacity: 0.75 }}
                    title={`Open toegang: elk account krijgt hier minstens de rol "${t.open_access_role}"`}
                  >
                    🔓
                  </span>
                )}
              </button>
            );
          })}
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

      {/* Licentie: sysadmin-only (zie /api/tenants/:tenantId/license, api/src/license.ts
          en doelenboom_licentiemodel.md) — welk tier deze tenant heeft en welke
          modules actief zijn. Toewijzen is een commerciële beslissing, geen
          zelfbedieningsactie voor een tenant-admin. Staat bewust boven
          "Instellingen": de licentie (incl. einddatum) bepaalt of de tenant
          hieronder überhaupt nog te wijzigen is. */}
      {selectedTenantId != null && user.isSysadmin && (
        <section style={styles.section}>
          <h2 style={styles.h2}>
            Licentie van {manageableTenants.find((t) => t.id === selectedTenantId)?.name ?? ''}
          </h2>
          <TenantLicensePanel key={selectedTenantId} token={token} tenantId={selectedTenantId} />
        </section>
      )}

      {selectedTenantId != null && (
        <section style={styles.section}>
          <h2 style={styles.h2}>
            Instellingen van {manageableTenants.find((t) => t.id === selectedTenantId)?.name ?? ''}
          </h2>
          {(() => {
            const t = manageableTenants.find((x) => x.id === selectedTenantId);
            if (!t) return null;
            return (
              <>
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
                {user.isSysadmin && (
                  <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #f0f1f3' }}>
                    <button
                      disabled={busy}
                      style={btnStyle('danger-text')}
                      onClick={async () => {
                        const ok = window.confirm(
                          `Tenant "${t.name}" volledig verwijderen? Alle doelenbomen, elementen, relaties, ` +
                          `tags, organisatieonderdelen, imports en leden hiervan gaan dan ook verloren. ` +
                          `Dit kan niet ongedaan worden gemaakt.`
                        );
                        if (!ok) return;
                        setBusy(true);
                        setError(null);
                        try {
                          await api.deleteTenant(token, t.id);
                          setSelectedTenantId(null);
                          api.tenants(token).then(setTenants).catch((err) => setError(errMsg(err)));
                          refreshDoelenbomen();
                        } catch (err) {
                          setError(errMsg(err));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Tenant verwijderen
                    </button>
                  </div>
                )}
              </>
            );
          })()}
        </section>
      )}

      {/* Standaardkolommen: sysadmin-only (zie /api/tenants/:tenantId/column-config),
          het sjabloon waarmee een NIEUWE doelenboom in deze tenant start (zie
          createDoelenboomConfigFromTenantDefault in api/src/columnConfig.ts) —
          wijzigt niets aan al bestaande doelenbomen, die hebben hun eigen kopie
          (zie de "Kolommen"-knop per doelenboom hieronder). */}
      {selectedTenantId != null && user.isSysadmin && (
        <section style={styles.section}>
          <h2 style={styles.h2}>
            Standaardkolommen van {manageableTenants.find((t) => t.id === selectedTenantId)?.name ?? ''}
          </h2>
          <p style={styles.muted}>
            Sjabloon waarmee een nieuwe doelenboom in deze tenant start. Bestaande doelenbomen hebben hun eigen,
            onafhankelijke kolommen (zie "Kolommen" bij de doelenboom zelf hieronder) en merken een wijziging hier
            dus niet.
          </p>
          <ColumnConfigEditor
            key={selectedTenantId}
            load={() => api.tenantColumnConfig(token, selectedTenantId)}
            save={(columns) => api.updateTenantColumnConfig(token, selectedTenantId, columns)}
          />
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
              isSysadmin={user.isSysadmin}
              tenants={tenants ?? []}
              busy={busy}
              setBusy={setBusy}
              setError={setError}
              onChanged={refreshDoelenbomen}
              onDuplicated={() => {
                refreshDoelenbomen();
                // Een duplicatie kan (bij "nieuwe tenant") een tenant hebben
                // aangemaakt — die moet dan ook in de tenant-lijst verschijnen.
                api.tenants(token).then(setTenants).catch((err) => setError(errMsg(err)));
              }}
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
    </main>
  );
}

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Er ging iets mis.';
}

// Herkent specifiek de "licentielimiet bereikt"-fout (zie LicenseLimitError /
// assertCanAddAdmin / assertCanCreateBoom in api/src/license.ts — 403 met een
// bericht dat altijd met deze tekst begint). Los van andere 403's (geen
// sysadmin, geen tenant-toegang, licentie verlopen, ...), die gewoon de
// generieke foutmelding houden — dit hier krijgt een eigen, duidelijk
// herkenbare waarschuwing i.p.v. een rode foutregel, omdat het geen bug is
// maar een verwachte, actie-baar-op-te-lossen situatie (afbouwen of upgraden).
function licenseLimitMessage(err: unknown): string | null {
  if (err instanceof ApiError && err.status === 403 && err.message.startsWith('Limiet van tier')) {
    return err.message;
  }
  return null;
}

function LicenseLimitWarning({ message }: { message: string }) {
  return (
    <p style={styles.licenseWarning}>
      <strong>Licentielimiet bereikt.</strong> {message}
    </p>
  );
}

// Generieke, lokale foutmelding vlak onder een formulier (i.p.v. alleen de
// gedeelde foutbalk bovenaan de pagina, die makkelijk buiten beeld valt als
// je verderop in het scherm een lid/doelenboom aan het toevoegen bent) — bv.
// "wachtwoord (min. 8 tekens) is verplicht" bij een nog onbekend e-mailadres.
// Ziet er bewust anders uit dan LicenseLimitWarning hierboven (rood i.p.v.
// amber): dit IS een fout die de gebruiker moet corrigeren, geen normale
// "eerst afbouwen of upgraden"-situatie.
function FormErrorNotice({ message }: { message: string }) {
  return <p style={styles.formErrorNotice}>{message}</p>;
}

// Kleurindicatie op de tenant-knop obv licentie-einddatum (t.license_end_date,
// "YYYY-MM-DD" of null): geen einddatum blijft ongewijzigd (geen kleur),
// groen als de datum verder dan een maand weg is, oranje binnen een maand
// (nog niet verlopen), rood als de datum al voorbij is. Zuivere
// string-vergelijking werkt hier omdat "YYYY-MM-DD" lexicografisch al
// chronologisch sorteert.
function licenseBorderColor(endDate: string | null): string | undefined {
  if (!endDate) return undefined;
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  if (endDate < todayStr) return '#DC3545'; // rood — al verlopen
  const oneMonthOut = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, today.getUTCDate()));
  const oneMonthStr = oneMonthOut.toISOString().slice(0, 10);
  if (endDate <= oneMonthStr) return '#E8A33D'; // oranje — binnen een maand
  return '#2e7d32'; // groen — verder dan een maand weg
}

function licenseBorderTitle(endDate: string | null): string | undefined {
  if (!endDate) return undefined;
  const color = licenseBorderColor(endDate);
  const nl = formatDateNL(endDate);
  if (color === '#DC3545') return `Licentie verlopen op ${nl}`;
  if (color === '#E8A33D') return `Licentie verloopt binnenkort: ${nl}`;
  return `Licentie geldig t/m ${nl}`;
}

// "YYYY-MM-DD" -> "dd-mm-jjjj", zelfde conventie als TenantLicensePanel.tsx.
function formatDateNL(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return dateStr;
  const [, y, mo, d] = m;
  return `${d}-${mo}-${y}`;
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
  const [licenseWarning, setLicenseWarning] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  async function changeRole(userId: number, role: TenantRoleName) {
    setBusy(true);
    setError(null);
    setLicenseWarning(null);
    setFormError(null);
    try {
      await api.updateTenantMemberRole(token, tenantId, userId, role);
      onChanged();
    } catch (err) {
      const licMsg = licenseLimitMessage(err);
      if (licMsg) setLicenseWarning(licMsg);
      else setFormError(errMsg(err));
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
    <div>
    {licenseWarning && <LicenseLimitWarning message={licenseWarning} />}
    {formError && <FormErrorNotice message={formError} />}
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
                <option value="bezoeker">bezoeker</option>
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
  const [licenseWarning, setLicenseWarning] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setLicenseWarning(null);
    setFormError(null);
    try {
      await api.addTenantMember(token, tenantId, { email, password: password || undefined, role });
      setEmail('');
      setPassword('');
      setRole('gebruiker');
      onAdded();
    } catch (err) {
      const licMsg = licenseLimitMessage(err);
      if (licMsg) setLicenseWarning(licMsg);
      else setFormError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
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
          <option value="bezoeker">bezoeker</option>
        </select>
        <button style={btnStyle('primary')} type="submit" disabled={busy}>
          + Lid toevoegen
        </button>
      </form>
      {licenseWarning && <LicenseLimitWarning message={licenseWarning} />}
      {formError && <FormErrorNotice message={formError} />}
    </div>
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
  isSysadmin,
  tenants,
  busy,
  setBusy,
  setError,
  onChanged,
  onDuplicated,
}: {
  token: string;
  tenantId: number;
  doelenbomen: DoelenboomSummary[];
  isSysadmin: boolean;
  tenants: TenantSummary[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onChanged: () => void;
  onDuplicated: () => void;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<number | null>(null);
  const [rolesEditingId, setRolesEditingId] = useState<number | null>(null);
  const [columnsEditingId, setColumnsEditingId] = useState<number | null>(null);
  const [templatingId, setTemplatingId] = useState<number | null>(null);
  const [templates, setTemplates] = useState<DoelenboomTemplateSummary[] | null>(null);

  function loadTemplates() {
    api.doelenboomTemplates(token, tenantId).then(setTemplates).catch((err) => setError(errMsg(err)));
  }

  useEffect(loadTemplates, [token, tenantId]);

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
      {doelenbomen.length === 0 && (
        <p style={styles.firstTreeCallout}>🌳 Maak hier uw eerste doelenboom aan</p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
        {doelenbomen.map((d) => {
          if (editingId === d.id) {
            return (
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
            );
          }
          if (duplicatingId === d.id) {
            return (
              <DuplicateDoelenboomForm
                key={d.id}
                token={token}
                doelenboom={d}
                tenants={tenants}
                busy={busy}
                setBusy={setBusy}
                setError={setError}
                onDuplicated={() => {
                  setDuplicatingId(null);
                  onDuplicated();
                }}
                onCancel={() => setDuplicatingId(null)}
              />
            );
          }
          if (templatingId === d.id) {
            return (
              <SaveAsTemplateForm
                key={d.id}
                token={token}
                doelenboom={d}
                isSysadmin={isSysadmin}
                busy={busy}
                setBusy={setBusy}
                setError={setError}
                onSaved={() => {
                  setTemplatingId(null);
                  loadTemplates();
                }}
                onCancel={() => setTemplatingId(null)}
              />
            );
          }
          if (rolesEditingId === d.id) {
            return (
              <DoelenboomMemberRolesSection
                key={d.id}
                token={token}
                doelenboom={d}
                busy={busy}
                setBusy={setBusy}
                setError={setError}
                onCancel={() => setRolesEditingId(null)}
              />
            );
          }
          if (columnsEditingId === d.id) {
            return (
              <div key={d.id} style={styles.doelenboomEditRow}>
                <p style={{ margin: 0, fontSize: 13.5, color: '#6c6f76' }}>
                  Kolommen van "{d.name}" — eigen, onafhankelijke kolomconfiguratie van déze doelenboom (los van de
                  standaardkolommen van de tenant). Een kolom verwijderen/hernoemen kan niet zolang er nog
                  elementen van dat type bestaan.
                </p>
                <ColumnConfigEditor
                  load={() => api.doelenboomColumnConfig(token, d.id)}
                  save={(columns) => api.updateDoelenboomColumnConfig(token, d.id, columns)}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => setColumnsEditingId(null)} style={btnStyle('ghost')} disabled={busy}>
                    Sluiten
                  </button>
                </div>
              </div>
            );
          }
          return (
            <div key={d.id} style={styles.doelenboomRow}>
              <div>
                <strong>{d.name}</strong> <span style={{ opacity: 0.6, fontSize: 12 }}>({d.slug})</span>
                {d.read_only && <span style={styles.mustChangeBadge}>alleen-lezen</span>}
                {d.wipe_on_empty && <span style={styles.mustChangeBadge}>auto-leegmaken</span>}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {isSysadmin && (
                  <button disabled={busy} onClick={() => setDuplicatingId(d.id)} style={btnStyle('ghost')}>
                    Dupliceren
                  </button>
                )}
                <button disabled={busy} onClick={() => setRolesEditingId(d.id)} style={btnStyle('ghost')}>
                  Rollen per lid
                </button>
                <button disabled={busy} onClick={() => setColumnsEditingId(d.id)} style={btnStyle('ghost')}>
                  Kolommen
                </button>
                <button disabled={busy} onClick={() => setTemplatingId(d.id)} style={btnStyle('ghost')}>
                  Opslaan als sjabloon
                </button>
                <button disabled={busy} onClick={() => setEditingId(d.id)} style={btnStyle('ghost')}>
                  Bewerken
                </button>
                <button disabled={busy} onClick={() => remove(d)} style={btnStyle('danger-text')}>
                  Verwijderen
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <CreateDoelenboomForm
        token={token}
        tenantId={tenantId}
        templates={templates}
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
  const [wipeOnEmpty, setWipeOnEmpty] = useState(doelenboom.wipe_on_empty);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateDoelenboom(token, doelenboom.id, { name, slug, readOnly, wipeOnEmpty });
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
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
        <input type="checkbox" checked={wipeOnEmpty} onChange={(e) => setWipeOnEmpty(e.target.checked)} />
        Automatisch leegmaken zodra niemand meer actief toegang heeft tot de tenant
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

// Sysadmin-only: dupliceert een doelenboom incl. alle inhoud (elementen,
// relaties, tags, org.-onderdelen, ...) — evt. naar een andere bestaande
// tenant of een gloednieuwe tenant. Excel-importhistorie wordt bewust niet
// meegekopieerd (zie api/src/routes/doelenbomen.ts). Route zelf is al
// sysadmin-gated; deze knop is client-side ook al alleen zichtbaar voor
// sysadmins, maar het formulier checkt niets extra — de server is de
// echte grens.
function DuplicateDoelenboomForm({
  token,
  doelenboom,
  tenants,
  busy,
  setBusy,
  setError,
  onDuplicated,
  onCancel,
}: {
  token: string;
  doelenboom: DoelenboomSummary;
  tenants: TenantSummary[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onDuplicated: () => void;
  onCancel: () => void;
}) {
  const [slug, setSlug] = useState(`${doelenboom.slug}-kopie`);
  const [name, setName] = useState(`${doelenboom.name} (kopie)`);
  const [target, setTarget] = useState<'same' | 'existing' | 'new'>('same');
  const [existingTenantId, setExistingTenantId] = useState<number | ''>('');
  const [newTenantSlug, setNewTenantSlug] = useState('');
  const [newTenantName, setNewTenantName] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Parameters<typeof api.duplicateDoelenboom>[2] = { slug, name };
      if (target === 'existing') {
        if (!existingTenantId) {
          setError('Kies een doel-tenant.');
          setBusy(false);
          return;
        }
        body.targetTenantId = existingTenantId;
      } else if (target === 'new') {
        if (!newTenantSlug.trim() || !newTenantName.trim()) {
          setError('Slug en naam van de nieuwe tenant zijn verplicht.');
          setBusy(false);
          return;
        }
        body.newTenant = { slug: newTenantSlug.trim(), name: newTenantName.trim() };
      }
      await api.duplicateDoelenboom(token, doelenboom.id, body);
      onDuplicated();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  const otherTenants = tenants.filter((t) => t.id !== doelenboom.tenant_id);

  return (
    <form onSubmit={submit} style={styles.doelenboomEditRow}>
      <p style={{ margin: 0, fontSize: 13.5, color: '#6c6f76' }}>
        "{doelenboom.name}" dupliceren, inclusief alle elementen, relaties, tags en organisatieonderdelen
        (importhistorie wordt niet meegekopieerd).
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="naam van de kopie"
          required
        />
        <input
          style={styles.input}
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="slug van de kopie"
          required
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13.5 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="radio" name="dup-target" checked={target === 'same'} onChange={() => setTarget('same')} />
          Binnen dezelfde tenant ({doelenboom.tenant_name})
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="radio" name="dup-target" checked={target === 'existing'} onChange={() => setTarget('existing')} />
          Naar een andere bestaande tenant
        </label>
        {target === 'existing' && (
          <select
            style={{ ...styles.input, marginLeft: 26 }}
            value={existingTenantId}
            onChange={(e) => setExistingTenantId(e.target.value ? Number(e.target.value) : '')}
          >
            <option value="">— kies tenant —</option>
            {otherTenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.slug})
              </option>
            ))}
          </select>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="radio" name="dup-target" checked={target === 'new'} onChange={() => setTarget('new')} />
          Naar een gloednieuwe tenant
        </label>
        {target === 'new' && (
          <div style={{ display: 'flex', gap: 8, marginLeft: 26 }}>
            <input
              style={styles.input}
              placeholder="naam nieuwe tenant"
              value={newTenantName}
              onChange={(e) => setNewTenantName(e.target.value)}
            />
            <input
              style={styles.input}
              placeholder="slug nieuwe tenant"
              value={newTenantSlug}
              onChange={(e) => setNewTenantSlug(e.target.value)}
            />
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={onCancel} style={btnStyle('ghost')} disabled={busy}>
          Annuleren
        </button>
        <button type="submit" style={btnStyle('primary')} disabled={busy}>
          Dupliceren
        </button>
      </div>
    </form>
  );
}

// Toont alle leden van de tenant van deze doelenboom, met hun tenant-rol en
// een dropdown om die specifiek voor déze doelenboom te overrulen (leeg =
// "gewoon de tenant-rol"). Zie api/src/routes/doelenbomen.ts (member-roles)
// en getEffectiveRoleForDoelenboom in api/src/rbac.ts voor hoe dit server-side
// wordt toegepast — dit scherm is puur de UI eromheen.
function DoelenboomMemberRolesSection({
  token,
  doelenboom,
  busy,
  setBusy,
  setError,
  onCancel,
}: {
  token: string;
  doelenboom: DoelenboomSummary;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<DoelenboomMemberRole[] | null>(null);

  function load() {
    api.doelenboomMemberRoles(token, doelenboom.id).then(setRows).catch((err) => setError(errMsg(err)));
  }

  useEffect(load, [token, doelenboom.id]);

  async function setRole(userId: number, role: TenantRoleName | null) {
    setBusy(true);
    setError(null);
    try {
      await api.setDoelenboomMemberRole(token, doelenboom.id, userId, role);
      load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.doelenboomEditRow}>
      <p style={{ margin: 0, fontSize: 13.5, color: '#6c6f76' }}>
        Rol per lid voor "{doelenboom.name}" — standaard de tenant-rol, hier per lid te overrulen (in beide
        richtingen: kan zowel meer als minder rechten geven dan de tenant-rol).
      </p>
      {!rows && <p style={styles.muted}>Laden…</p>}
      {rows && rows.length === 0 && <p style={styles.muted}>Geen leden in deze tenant.</p>}
      {rows && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((r) => (
            <div key={r.userId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
              <span style={{ flex: 1 }}>
                {r.email} <span style={{ opacity: 0.6, fontSize: 12 }}>(tenant-rol: {r.tenantRole})</span>
              </span>
              <select
                style={styles.select}
                value={r.overrideRole ?? ''}
                disabled={busy}
                onChange={(e) => setRole(r.userId, e.target.value ? (e.target.value as TenantRoleName) : null)}
              >
                <option value="">(zelfde als tenant: {r.tenantRole})</option>
                <option value="admin">Admin (op deze doelenboom)</option>
                <option value="gebruiker">Gebruiker (op deze doelenboom)</option>
                <option value="bezoeker">Bezoeker (op deze doelenboom)</option>
              </select>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={onCancel} style={btnStyle('ghost')} disabled={busy}>
          Sluiten
        </button>
      </div>
    </div>
  );
}

function CreateDoelenboomForm({
  token,
  tenantId,
  templates,
  busy,
  setBusy,
  setError,
  onCreated,
}: {
  token: string;
  tenantId: number;
  templates: DoelenboomTemplateSummary[] | null;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onCreated: () => void;
}) {
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  // Standaard het eerste sjabloon uit de lijst (systeembrede sjablonen staan
  // vooraan, zie listTemplatesForTenant in api/src/doelenboomTemplates.ts —
  // dat is meestal "Batenboom"). '' = geen sjabloon meegeven (server valt dan
  // terug op de oude tenant-default-kolommen, zie routes/doelenbomen.ts).
  const [templateId, setTemplateId] = useState<number | ''>('');
  const [licenseWarning, setLicenseWarning] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (templates && templates.length > 0 && templateId === '') {
      setTemplateId(templates[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setLicenseWarning(null);
    setFormError(null);
    try {
      await api.createDoelenboom(token, tenantId, {
        slug,
        name,
        ...(templateId !== '' ? { templateId } : {}),
      });
      setSlug('');
      setName('');
      onCreated();
    } catch (err) {
      const licMsg = licenseLimitMessage(err);
      if (licMsg) setLicenseWarning(licMsg);
      else setFormError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form onSubmit={submit} style={styles.inlineForm}>
        <input style={styles.input} placeholder="slug" required value={slug} onChange={(e) => setSlug(e.target.value)} />
        <input style={styles.input} placeholder="naam" required value={name} onChange={(e) => setName(e.target.value)} />
        <select
          style={styles.select}
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : '')}
          title="Sjabloon: bepaalt de kolommen en het voorbeeldpad waarmee de nieuwe doelenboom start"
        >
          <option value="">(geen sjabloon — tenant-standaardkolommen)</option>
          {(templates ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.tenantId == null ? '🌐 ' : ''}
              {t.name}
            </option>
          ))}
        </select>
        <button style={btnStyle('primary')} type="submit" disabled={busy}>
          + Doelenboom aanmaken
        </button>
      </form>
      {licenseWarning && <LicenseLimitWarning message={licenseWarning} />}
      {formError && <FormErrorNotice message={formError} />}
    </div>
  );
}

// Een bestaande doelenboom opslaan als herbruikbaar sjabloon (kolommen +
// voorbeeldelementen + relaties, zie api/src/doelenboomTemplates.ts) — geen
// aparte sjabloon-editor, dit IS de manier om een sjabloon te maken/bijwerken
// (opnieuw opslaan onder een andere naam). scope='global' (systeembreed,
// zichtbaar/bruikbaar voor elke tenant) mag alleen een sysadmin kiezen — de
// server handhaaft dit ook, dit formulier toont die optie alleen als isSysadmin.
function SaveAsTemplateForm({
  token,
  doelenboom,
  isSysadmin,
  busy,
  setBusy,
  setError,
  onSaved,
  onCancel,
}: {
  token: string;
  doelenboom: DoelenboomSummary;
  isSysadmin: boolean;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(doelenboom.name);
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<'tenant' | 'global'>('tenant');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.saveDoelenboomAsTemplate(token, doelenboom.id, { name, description, scope });
      onSaved();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={styles.doelenboomEditRow}>
      <p style={{ margin: 0, fontSize: 13.5, color: '#6c6f76' }}>
        "{doelenboom.name}" opslaan als sjabloon — de huidige kolommen en elementen/relaties worden een
        momentopname die je later kunt kiezen bij het aanmaken van een nieuwe doelenboom. Wijzigingen hierna
        aan "{doelenboom.name}" zelf werken niet door in dit sjabloon.
      </p>
      <input
        style={styles.input}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="naam van het sjabloon"
        required
      />
      <input
        style={styles.input}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="korte omschrijving (optioneel)"
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13.5 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="radio" name="template-scope" checked={scope === 'tenant'} onChange={() => setScope('tenant')} />
          Voor deze organisatie ({doelenboom.tenant_name})
        </label>
        {isSysadmin && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="radio" name="template-scope" checked={scope === 'global'} onChange={() => setScope('global')} />
            Systeembreed (zichtbaar/bruikbaar voor elke tenant)
          </label>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={onCancel} style={btnStyle('ghost')} disabled={busy}>
          Annuleren
        </button>
        <button type="submit" style={btnStyle('primary')} disabled={busy}>
          Opslaan als sjabloon
        </button>
      </div>
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
  const [openAccessRole, setOpenAccessRole] = useState<TenantRoleName | ''>(tenant.open_access_role ?? '');
  const [saved, setSaved] = useState(false);

  // Als de gebruiker een andere tenant selecteert moet het formulier de
  // waarden van díe tenant tonen, niet de vorige selectie blijven vasthouden.
  useEffect(() => {
    setWipeOnEmpty(tenant.wipe_on_empty);
    setTimeoutMinutes(String(tenant.session_timeout_minutes));
    setOpenAccessRole(tenant.open_access_role ?? '');
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
      await api.updateTenantSettings(token, tenant.id, {
        wipeOnEmpty,
        sessionTimeoutMinutes: minutes,
        openAccessRole: openAccessRole || null,
      });
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
        Standaardinstelling voor nieuwe doelenbomen in deze tenant: automatisch leegmaken zodra niemand meer
        actief toegang heeft
      </label>
      <p style={{ margin: '-4px 0 0 26px', fontSize: 12, color: '#9aa0a8' }}>
        Geldt alleen bij het aanmaken van een nieuwe doelenboom — per bestaande doelenboom is dit apart
        instelbaar bij "Doelenbomen" hieronder.
      </p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
        Na
        <input
          style={{ ...styles.input, width: 70 }}
          type="number"
          min={1}
          value={timeoutMinutes}
          onChange={(e) => setTimeoutMinutes(e.target.value)}
        />
        minuten inactiviteit (geldt voor de hele tenant)
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
        Open toegang voor alle accounts:
        <select
          style={styles.select}
          value={openAccessRole}
          onChange={(e) => setOpenAccessRole(e.target.value as TenantRoleName | '')}
        >
          <option value="">Uit — alleen expliciete leden</option>
          <option value="bezoeker">Aan — iedereen: bezoeker</option>
          <option value="gebruiker">Aan — iedereen: gebruiker</option>
          <option value="admin">Aan — iedereen: admin</option>
        </select>
      </label>
      <p style={{ margin: '-4px 0 0 0', fontSize: 12, color: '#9aa0a8' }}>
        Staat dit aan, dan krijgt elk account met een login — ook zonder dat je 'm hieronder bij "Leden" hoeft
        toe te voegen — minstens deze rol in deze tenant (bv. handig voor de Demo-tenant). Iemand die je zelf
        als lid toevoegt met een andere rol houdt gewoon díe rol; dit is alleen de ondergrens voor wie geen
        eigen lidmaatschap heeft.
      </p>
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
  // Zelfde pil-vormige zoekbalk-stijl als in een doelenboom zelf (zie
  // .search-input/.search-clear-btn in tree.html) — herkenbaar hetzelfde
  // patroon, hier alleen als React inline-stijl i.p.v. CSS-klasse.
  tenantSearchWrap: { position: 'relative', display: 'inline-flex', alignItems: 'center', margin: '2px 0 12px' },
  tenantSearchInput: {
    fontFamily: 'inherit', fontSize: 13.5, padding: '9px 34px 9px 14px', borderRadius: 999,
    border: '1.5px solid #ccc', width: 260, maxWidth: '60vw', outline: 'none', boxSizing: 'border-box',
  },
  tenantSearchClear: {
    position: 'absolute', right: 6, width: 22, height: 22, borderRadius: '50%', border: 'none',
    background: '#e2e4e8', color: '#555', fontSize: 13, lineHeight: 1, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
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
  // Prominente call-to-action i.p.v. de gewone "muted" lege-staat-tekst,
  // zolang een tenant nog geen enkele doelenboom heeft (bv. meteen na een
  // geslaagde zelfbedieningsaanvraag, zie App.tsx) — wijst expliciet naar het
  // aanmaakformulier eronder.
  firstTreeCallout: {
    display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 12px', padding: '10px 14px',
    borderRadius: 8, background: '#EAF1FE', border: '1px solid #C7D7F5', color: '#203864',
    fontSize: 13.5, fontWeight: 600,
  },
  mustChangeBadge: {
    marginLeft: 8, fontSize: 11, color: '#946200', background: '#FFF3CD',
    border: '1px solid #FFE69C', borderRadius: 999, padding: '2px 8px',
  },
  // Functionele waarschuwing bij een bereikte licentielimiet (zie
  // licenseLimitMessage/LicenseLimitWarning hierboven) — bewust amber i.p.v.
  // rood: dit is geen fout in de app, maar een verwachte, oplosbare situatie.
  licenseWarning: {
    margin: '10px 0 0', fontSize: 13, lineHeight: 1.5, color: '#946200',
    background: '#FFF3CD', border: '1px solid #FFE69C', borderRadius: 8, padding: '8px 12px',
  },
  // Generieke lokale foutmelding (zie FormErrorNotice hierboven) — zelfde
  // vorm als licenseWarning, maar rood i.p.v. amber.
  formErrorNotice: {
    margin: '10px 0 0', fontSize: 13, lineHeight: 1.5, color: '#842029',
    background: '#F8D7DA', border: '1px solid #F1AEB5', borderRadius: 8, padding: '8px 12px',
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

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Zelfde localStorage-sleutel als useSession.ts — hier niet als import omdat
// dat een React-hook is en dit een gewone module-level functie, geen component.
const SESSION_STORAGE_KEY = 'doelenboom.session';

// sessionStorage (niet localStorage: mag niet blijven hangen na deze ene
// reload/tab) — zet App.tsx hiermee een uitlogreden klaar vóór de
// pagina-herlaad hieronder, zodat LoginPage.tsx na de reload kan tonen WAAROM
// iemand terug op het inlogscherm staat i.p.v. stilzwijgend uit te loggen.
// Alleen voor de twee redenen die de gebruiker daadwerkelijk iets uitleggen
// (idle_timeout/session_ended) — 'not_logged_in'/'invalid_token' zijn de
// normale "je bent gewoon niet ingelogd"-gevallen, geen melding nodig.
const AUTH_NOTICE_KEY = 'doelenboom.authNotice';

async function request<T>(path: string, options: RequestInit = {}, token?: string | null): Promise<T> {
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> | undefined) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    let message = res.statusText;
    let reason: string | undefined;
    try {
      const body = await res.json();
      message = body.error ?? body.detail ?? message;
      reason = body.reason;
    } catch {
      // response had geen JSON-body
    }
    // Alleen bij een 401 op een call die zelf al een token meestuurde (dus niet
    // /auth/login zelf, waar 401 gewoon "onjuist wachtwoord" betekent): de JWT
    // is verlopen of ongeldig geworden — bv. door de 15-minuten-inactiviteit-
    // beveiliging (reason 'idle_timeout', zie api/src/auth.ts requireAuth) of
    // een sessie die elders al is beëindigd ('session_ended'). Zonder dit bleef
    // de gebruiker vast hangen op een scherm met alleen deze foutmelding in
    // rode tekst, zonder duidelijk herstelpad terug naar het inlogscherm (zelfs
    // "Uitloggen" werkt dan niet, want dat vereist zelf ook weer een geldige
    // sessie). Lokale sessie wissen + herladen brengt de gebruiker direct terug
    // bij LoginPage — de reason wordt eerst kort bewaard (sessionStorage, dus
    // per tab, niet blijvend) zodat LoginPage na de reload kan tonen waarom.
    if (res.status === 401 && token) {
      if (reason === 'idle_timeout' || reason === 'session_ended') {
        sessionStorage.setItem(AUTH_NOTICE_KEY, reason);
      }
      localStorage.removeItem(SESSION_STORAGE_KEY);
      window.location.reload();
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; user: import('./types').User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  doelenbomen: (token: string) => request<import('./types').DoelenboomSummary[]>('/api/doelenbomen', {}, token),

  createDoelenboom: (token: string, tenantId: number, body: { slug: string; name: string }) =>
    request<import('./types').DoelenboomBase>(`/api/tenants/${tenantId}/doelenbomen`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, token),

  updateDoelenboom: (
    token: string,
    doelenboomId: number,
    body: { name: string; slug?: string; readOnly?: boolean; wipeOnEmpty?: boolean; archived?: boolean }
  ) =>
    request<import('./types').DoelenboomBase>(`/api/doelenbomen/${doelenboomId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }, token),

  deleteDoelenboom: (token: string, doelenboomId: number) =>
    request<void>(`/api/doelenbomen/${doelenboomId}`, { method: 'DELETE' }, token),

  // Per-doelenboom rol-overrides (overrult tenant_users.role voor één gebruiker
  // op één doelenboom) — zie api/src/routes/doelenbomen.ts.
  doelenboomMemberRoles: (token: string, doelenboomId: number) =>
    request<import('./types').DoelenboomMemberRole[]>(`/api/doelenbomen/${doelenboomId}/member-roles`, {}, token),

  setDoelenboomMemberRole: (token: string, doelenboomId: number, userId: number, role: import('./types').TenantRoleName | null) =>
    request<void>(`/api/doelenbomen/${doelenboomId}/member-roles/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    }, token),

  // Sysadmin-only — zie api/src/routes/doelenbomen.ts. targetTenantId en newTenant
  // zijn elkaar uitsluitend: geen van beide meegeven dupliceert binnen dezelfde tenant.
  duplicateDoelenboom: (
    token: string,
    doelenboomId: number,
    body: { slug: string; name: string; targetTenantId?: number; newTenant?: { slug: string; name: string } }
  ) =>
    request<import('./types').DoelenboomSummary>(`/api/doelenbomen/${doelenboomId}/duplicate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, token),

  tree: (token: string, id: number | string) =>
    request<import('./types').TreeResponse>(`/api/doelenbomen/${id}/tree`, {}, token),

  imports: (token: string, doelenboomId: number | string) =>
    request<import('./types').ImportSummary[]>(`/api/doelenbomen/${doelenboomId}/imports`, {}, token),

  importDetail: (token: string, importId: number | string) =>
    request<import('./types').ImportDetail>(`/api/imports/${importId}`, {}, token),

  uploadImport: (token: string, doelenboomId: number | string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<import('./types').ImportSummary>(`/api/doelenbomen/${doelenboomId}/imports`, {
      method: 'POST',
      body: form,
    }, token);
  },

  publishImport: (token: string, importId: number | string) =>
    request<{ status: string; elementCount: number; edgeCount: number }>(`/api/imports/${importId}/publish`, {
      method: 'POST',
    }, token),

  heartbeat: (token: string) => request<void>('/api/auth/heartbeat', { method: 'POST' }, token),

  // Échte-activiteit-ping (i.t.t. heartbeat hierboven, dat een blinde "tab
  // staat open"-timer is) — basis van de 15-minuten-inactiviteit-uitlog-
  // beveiliging (api/src/auth.ts requireAuth). Zie useActivityPing.ts.
  recordActivity: (token: string) => request<void>('/api/auth/activity', { method: 'POST' }, token),

  changePassword: (token: string, currentPassword: string, newPassword: string) =>
    request<{ user: import('./types').User }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }, token),

  logoutPreview: (token: string) =>
    request<{ wouldWipe: import('./types').WipeCandidate[] }>('/api/auth/logout-preview', {}, token),

  logout: (token: string) =>
    request<{ wiped: import('./types').WipeCandidate[] }>('/api/auth/logout', { method: 'POST' }, token),

  // --- Tenants ---
  tenants: (token: string) => request<import('./types').TenantSummary[]>('/api/tenants', {}, token),

  createTenant: (token: string, slug: string, name: string) =>
    request<import('./types').TenantSummary>('/api/tenants', {
      method: 'POST',
      body: JSON.stringify({ slug, name }),
    }, token),

  updateTenantSettings: (
    token: string,
    tenantId: number,
    patch: {
      wipeOnEmpty?: boolean;
      sessionTimeoutMinutes?: number;
      // Alleen meesturen als je 'm ook echt wil wijzigen (undefined = laat
      // ongemoeid) — null zet open toegang expliciet uit, zie PUT
      // /api/tenants/:id (routes/tenants.ts) voor de tri-state-uitleg.
      openAccessRole?: import('./types').TenantRoleName | null;
    }
  ) =>
    request<import('./types').TenantSummary>(`/api/tenants/${tenantId}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }, token),

  // Sysadmin-only — verwijdert de tenant zelf plus (cascade) al zijn leden,
  // doelenbomen en boom-inhoud. Zie api/src/routes/tenants.ts.
  deleteTenant: (token: string, tenantId: number) =>
    request<void>(`/api/tenants/${tenantId}`, { method: 'DELETE' }, token),

  // --- Tenant-leden (rol admin/gebruiker binnen één tenant) ---
  tenantMembers: (token: string, tenantId: number) =>
    request<import('./types').TenantMember[]>(`/api/tenants/${tenantId}/members`, {}, token),

  addTenantMember: (token: string, tenantId: number, body: { email: string; password?: string; role: import('./types').TenantRoleName }) =>
    request<{ userId: number; email: string; role: string }>(`/api/tenants/${tenantId}/members`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, token),

  updateTenantMemberRole: (token: string, tenantId: number, userId: number, role: import('./types').TenantRoleName) =>
    request<{ userId: number; role: string }>(`/api/tenants/${tenantId}/members/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    }, token),

  removeTenantMember: (token: string, tenantId: number, userId: number) =>
    request<void>(`/api/tenants/${tenantId}/members/${userId}`, { method: 'DELETE' }, token),

  // --- Gebruikersaccounts (sysadmin-only) ---
  users: (token: string) => request<import('./types').UserSummary[]>('/api/users', {}, token),

  createUser: (token: string, body: { email: string; password: string; isSysadmin?: boolean; mustChangePassword?: boolean }) =>
    request<import('./types').UserSummary>('/api/users', { method: 'POST', body: JSON.stringify(body) }, token),

  updateUser: (
    token: string,
    userId: number,
    body: { email?: string; password?: string; isSysadmin?: boolean; mustChangePassword?: boolean }
  ) => request<import('./types').UserSummary>(`/api/users/${userId}`, { method: 'PUT', body: JSON.stringify(body) }, token),

  deleteUser: (token: string, userId: number) =>
    request<void>(`/api/users/${userId}`, { method: 'DELETE' }, token),

  // --- Kolomconfiguratie (zie docs/kolommen-configuratie-ontwerp.md) ---
  // Tenant-default: sysadmin-only, het sjabloon waarmee een nieuwe doelenboom
  // binnen die tenant start. Doelenboom-config: de eigen, onafhankelijke
  // kolommenset van die ene doelenboom (lezen mag iedereen met toegang tot de
  // doelenboom, wijzigen alleen met schrijfrechten — zie api/src/rbac.ts).
  tenantColumnConfig: (token: string, tenantId: number) =>
    request<{ columns: import('./types').ColumnDef[] }>(`/api/tenants/${tenantId}/column-config`, {}, token),

  updateTenantColumnConfig: (token: string, tenantId: number, columns: import('./types').ColumnDef[]) =>
    request<{ columns: import('./types').ColumnDef[] }>(`/api/tenants/${tenantId}/column-config`, {
      method: 'PUT',
      body: JSON.stringify({ columns }),
    }, token),

  doelenboomColumnConfig: (token: string, doelenboomId: number) =>
    request<{ columns: import('./types').ColumnDef[] }>(`/api/doelenbomen/${doelenboomId}/column-config`, {}, token),

  updateDoelenboomColumnConfig: (token: string, doelenboomId: number, columns: import('./types').ColumnDef[]) =>
    request<{ columns: import('./types').ColumnDef[] }>(`/api/doelenbomen/${doelenboomId}/column-config`, {
      method: 'PUT',
      body: JSON.stringify({ columns }),
    }, token),

  // --- Licentiemodel (zie doelenboom_licentiemodel.md) ---
  // Tiers/modules-catalogus: lezen mag iedereen ingelogd, wijzigen is
  // sysadmin-only (de server handhaaft dit, zie api/src/routes/licenses.ts).
  tiers: (token: string) => request<import('./types').Tier[]>('/api/tiers', {}, token),

  createTier: (token: string, body: { name: string; maxAdmins: number; maxBomen: number; sortOrder: number }) =>
    request<import('./types').Tier>('/api/tiers', { method: 'POST', body: JSON.stringify(body) }, token),

  updateTier: (
    token: string,
    tierId: number,
    body: Partial<{ name: string; maxAdmins: number; maxBomen: number; sortOrder: number }>
  ) => request<import('./types').Tier>(`/api/tiers/${tierId}`, { method: 'PUT', body: JSON.stringify(body) }, token),

  deleteTier: (token: string, tierId: number) => request<void>(`/api/tiers/${tierId}`, { method: 'DELETE' }, token),

  modules: (token: string) => request<import('./types').ModuleDef[]>('/api/modules', {}, token),

  createModule: (token: string, body: { key: string; name: string; description: string }) =>
    request<import('./types').ModuleDef>('/api/modules', { method: 'POST', body: JSON.stringify(body) }, token),

  updateModule: (token: string, moduleId: number, body: Partial<{ name: string; description: string }>) =>
    request<import('./types').ModuleDef>(`/api/modules/${moduleId}`, { method: 'PUT', body: JSON.stringify(body) }, token),

  deleteModule: (token: string, moduleId: number) =>
    request<void>(`/api/modules/${moduleId}`, { method: 'DELETE' }, token),

  // Per-tenant licentie: huidig tier + actieve modules + gebruik. Lezen mag
  // een sysadmin of tenant-admin van díe tenant; wijzigen (tier/modules) is
  // sysadmin-only.
  tenantLicense: (token: string, tenantId: number) =>
    request<import('./types').TenantLicense>(`/api/tenants/${tenantId}/license`, {}, token),

  setTenantTier: (token: string, tenantId: number, tierId: number | null) =>
    request<import('./types').TenantLicense>(`/api/tenants/${tenantId}/license/tier`, {
      method: 'PUT',
      body: JSON.stringify({ tierId }),
    }, token),

  setTenantModule: (token: string, tenantId: number, moduleKey: string, active: boolean) =>
    request<import('./types').TenantLicense>(`/api/tenants/${tenantId}/license/modules/${moduleKey}`, {
      method: 'PUT',
      body: JSON.stringify({ active }),
    }, token),

  // endDate: "YYYY-MM-DD" of null (geen einddatum ingesteld/nooit verlopen).
  setTenantLicenseEndDate: (token: string, tenantId: number, endDate: string | null) =>
    request<import('./types').TenantLicense>(`/api/tenants/${tenantId}/license/end-date`, {
      method: 'PUT',
      body: JSON.stringify({ endDate }),
    }, token),

  // --- Database-overzicht (sysadmin-only, /dbstat) ---
  dbStat: (token: string) => request<import('./types').DbStatTenant[]>('/api/dbstat', {}, token),

  // --- Login-overzicht (sysadmin-only, /sessions): wie is (recent) ingelogd, wanneer ---
  sessions: (token: string) => request<import('./types').SessionInfo[]>('/api/sessions', {}, token),

  // --- Systeemmelding (bv. onderhoudsaankondiging) — zie api/src/routes/announcement.ts ---
  // GET is bewust ongeauthenticeerd (ook zichtbaar vóór inloggen), dus geen token-param.
  announcement: () => request<import('./types').SystemAnnouncement>('/api/announcement', {}),

  updateAnnouncement: (token: string, body: { message: string; active: boolean }) =>
    request<import('./types').SystemAnnouncement>('/api/announcement', {
      method: 'PUT',
      body: JSON.stringify(body),
    }, token),

  // Bouwversie (git-hash + datum, via Docker build-arg — zie api/Dockerfile en
  // docker-compose.yml) voor de versie-footer (App.tsx). Geen token nodig:
  // dit staat ook zichtbaar voordat iemand is ingelogd.
  version: () => request<{ version: string }>('/api/version', {}),
};

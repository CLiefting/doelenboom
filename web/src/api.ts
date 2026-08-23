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

async function request<T>(path: string, options: RequestInit = {}, token?: string | null): Promise<T> {
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> | undefined) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.error ?? body.detail ?? message;
    } catch {
      // response had geen JSON-body
    }
    // Alleen bij een 401 op een call die zelf al een token meestuurde (dus niet
    // /auth/login zelf, waar 401 gewoon "onjuist wachtwoord" betekent): de JWT
    // is verlopen of ongeldig geworden. Zonder dit bleef de gebruiker vast
    // hangen op een scherm met alleen deze foutmelding in rode tekst, zonder
    // duidelijk herstelpad terug naar het inlogscherm (zelfs "Uitloggen" werkt
    // dan niet, want dat vereist zelf ook weer een geldige sessie). Lokale
    // sessie wissen + herladen brengt de gebruiker direct terug bij LoginPage.
    if (res.status === 401 && token) {
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
    body: { name: string; slug?: string; readOnly?: boolean; wipeOnEmpty?: boolean }
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

  setDoelenboomMemberRole: (token: string, doelenboomId: number, userId: number, role: 'admin' | 'gebruiker' | null) =>
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

  updateTenantSettings: (token: string, tenantId: number, patch: { wipeOnEmpty?: boolean; sessionTimeoutMinutes?: number }) =>
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

  addTenantMember: (token: string, tenantId: number, body: { email: string; password?: string; role: 'admin' | 'gebruiker' }) =>
    request<{ userId: number; email: string; role: string }>(`/api/tenants/${tenantId}/members`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, token),

  updateTenantMemberRole: (token: string, tenantId: number, userId: number, role: 'admin' | 'gebruiker') =>
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

  // --- Database-overzicht (sysadmin-only, /dbstat) ---
  dbStat: (token: string) => request<import('./types').DbStatTenant[]>('/api/dbstat', {}, token),

  // --- Login-overzicht (sysadmin-only, /sessions): wie is (recent) ingelogd, wanneer ---
  sessions: (token: string) => request<import('./types').SessionInfo[]>('/api/sessions', {}, token),

  // Bouwversie (git-hash + datum, via Docker build-arg — zie api/Dockerfile en
  // docker-compose.yml) voor de versie-footer (App.tsx). Geen token nodig:
  // dit staat ook zichtbaar voordat iemand is ingelogd.
  version: () => request<{ version: string }>('/api/version', {}),
};

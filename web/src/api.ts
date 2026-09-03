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
    request<import('./types').LoginResult>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  // --- MFA (tweestapsverificatie) — zie doelenboom_mfa_ontwerp.md §2/§6 ---
  verifyMfa: (challengeId: string, code: string) =>
    request<{ token: string; user: import('./types').User }>('/api/auth/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId, code }),
    }),

  resendMfa: (challengeId: string) =>
    request<{ expiresInSeconds: number }>('/api/auth/mfa/resend', {
      method: 'POST',
      body: JSON.stringify({ challengeId }),
    }),

  // Zelfbedieningsschakelaar (niet-sysadmins, zie MySecurityPage.tsx).
  updateMyMfaSetting: (token: string, enabled: boolean) =>
    request<{ mfaEnabled: boolean }>('/api/auth/mfa-enabled', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }, token),

  doelenbomen: (token: string) => request<import('./types').DoelenboomSummary[]>('/api/doelenbomen', {}, token),

  createDoelenboom: (token: string, tenantId: number, body: { slug: string; name: string; templateId?: number }) =>
    request<import('./types').DoelenboomBase>(`/api/tenants/${tenantId}/doelenbomen`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, token),

  // --- Doelenboom-sjablonen (zie api/src/doelenboomTemplates.ts) ---
  doelenboomTemplates: (token: string, tenantId: number) =>
    request<import('./types').DoelenboomTemplateSummary[]>(`/api/tenants/${tenantId}/doelenboom-templates`, {}, token),

  saveDoelenboomAsTemplate: (
    token: string,
    doelenboomId: number,
    body: { name: string; description: string; scope: 'tenant' | 'global' }
  ) =>
    request<import('./types').DoelenboomTemplateSummary>(`/api/doelenbomen/${doelenboomId}/save-as-template`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, token),

  deleteDoelenboomTemplate: (token: string, templateId: number) =>
    request<void>(`/api/doelenboom-templates/${templateId}`, { method: 'DELETE' }, token),

  // Alle sjablonen die deze gebruiker mag beheren, over alle tenants heen —
  // voor het aparte Sjablonenbeheer-scherm (DoelenboomTemplatesPage.tsx).
  allDoelenboomTemplates: (token: string) =>
    request<import('./types').DoelenboomTemplateSummary[]>('/api/doelenboom-templates', {}, token),

  updateDoelenboomTemplateMeta: (token: string, templateId: number, body: { name?: string; description?: string }) =>
    request<import('./types').DoelenboomTemplateSummary>(`/api/doelenboom-templates/${templateId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }, token),

  templateColumnConfig: (token: string, templateId: number) =>
    request<{ columns: import('./types').ColumnDef[] }>(`/api/doelenboom-templates/${templateId}/column-config`, {}, token),

  updateTemplateColumnConfig: (token: string, templateId: number, columns: import('./types').ColumnDef[]) =>
    request<{ columns: import('./types').ColumnDef[] }>(`/api/doelenboom-templates/${templateId}/column-config`, {
      method: 'PUT',
      body: JSON.stringify({ columns }),
    }, token),

  refreshTemplateFromDoelenboom: (token: string, templateId: number, doelenboomId: number) =>
    request<{ columns: import('./types').ColumnDef[] }>(`/api/doelenboom-templates/${templateId}/refresh-from-doelenboom`, {
      method: 'POST',
      body: JSON.stringify({ doelenboomId }),
    }, token),

  updateDoelenboom: (
    token: string,
    doelenboomId: number,
    body: {
      name: string;
      slug?: string;
      readOnly?: boolean;
      wipeOnEmpty?: boolean;
      nightlyExportEnabled?: boolean;
      archived?: boolean;
      staleAfterDays?: number;
    }
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
      nightlyExportEnabled?: boolean;
      // Alleen meesturen als je 'm ook echt wil wijzigen (undefined = laat
      // ongemoeid) — null zet open toegang expliciet uit, zie PUT
      // /api/tenants/:id (routes/tenants.ts) voor de tri-state-uitleg.
      openAccessRole?: import('./types').TenantRoleName | null;
      // Bij entryPopupEnabled: true moet entryPopupMessage in dezelfde
      // aanroep een niet-lege tekst zijn — zie PUT /api/tenants/:id.
      entryPopupEnabled?: boolean;
      entryPopupMessage?: string;
      // Sysadmin-only (server geeft 403 terug als een tenant-admin dit
      // meestuurt) — zie PUT /api/tenants/:id.
      name?: string;
      slug?: string;
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
    body: { email?: string; password?: string; isSysadmin?: boolean; mustChangePassword?: boolean; mfaEnabled?: boolean }
  ) => request<import('./types').UserSummary>(`/api/users/${userId}`, { method: 'PUT', body: JSON.stringify(body) }, token),

  deleteUser: (token: string, userId: number) =>
    request<void>(`/api/users/${userId}`, { method: 'DELETE' }, token),

  // --- App-brede instellingen (sysadmin-only, zie api/src/appSettings.ts) ---
  appSettings: (token: string) => request<import('./types').AppSettings>('/api/app-settings', {}, token),

  updateAppSettings: (
    token: string,
    patch: { maxFailedLoginAttempts?: number; loginLockoutMinutes?: number }
  ) =>
    request<import('./types').AppSettings>('/api/app-settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }, token),

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

  createTier: (
    token: string,
    body: {
      name: string;
      maxAdmins: number;
      maxBomen: number;
      sortOrder: number;
      trialDays?: number | null;
      allModulesIncluded?: boolean;
    }
  ) => request<import('./types').Tier>('/api/tiers', { method: 'POST', body: JSON.stringify(body) }, token),

  updateTier: (
    token: string,
    tierId: number,
    body: Partial<{
      name: string;
      maxAdmins: number;
      maxBomen: number;
      sortOrder: number;
      trialDays: number | null;
      allModulesIncluded: boolean;
    }>
  ) => request<import('./types').Tier>(`/api/tiers/${tierId}`, { method: 'PUT', body: JSON.stringify(body) }, token),

  deleteTier: (token: string, tierId: number) => request<void>(`/api/tiers/${tierId}`, { method: 'DELETE' }, token),

  // --- Prijsgeschiedenis van tiers — zie doelenboom_licentiemodel.md §9 ---

  tierPrices: (token: string, tierId: number) =>
    request<import('./types').TierPrice[]>(`/api/tiers/${tierId}/prices`, {}, token),

  createTierPrice: (token: string, tierId: number, body: { priceEur: number; validFrom: string; validUntil: string }) =>
    request<import('./types').TierPrice>(`/api/tiers/${tierId}/prices`, { method: 'POST', body: JSON.stringify(body) }, token),

  updateTierPrice: (token: string, priceId: number, body: { priceEur: number; validFrom: string; validUntil: string }) =>
    request<import('./types').TierPrice>(`/api/tier-prices/${priceId}`, { method: 'PUT', body: JSON.stringify(body) }, token),

  deleteTierPrice: (token: string, priceId: number) =>
    request<void>(`/api/tier-prices/${priceId}`, { method: 'DELETE' }, token),

  modules: (token: string) => request<import('./types').ModuleDef[]>('/api/modules', {}, token),

  createModule: (token: string, body: { key: string; name: string; description: string }) =>
    request<import('./types').ModuleDef>('/api/modules', { method: 'POST', body: JSON.stringify(body) }, token),

  updateModule: (token: string, moduleId: number, body: Partial<{ name: string; description: string }>) =>
    request<import('./types').ModuleDef>(`/api/modules/${moduleId}`, { method: 'PUT', body: JSON.stringify(body) }, token),

  deleteModule: (token: string, moduleId: number) =>
    request<void>(`/api/modules/${moduleId}`, { method: 'DELETE' }, token),

  // --- Opslagpercentage-geschiedenis van modules — zie doelenboom_licentiemodel.md §3/§9 ---

  moduleSurcharges: (token: string, moduleId: number) =>
    request<import('./types').ModuleSurcharge[]>(`/api/modules/${moduleId}/surcharges`, {}, token),

  createModuleSurcharge: (token: string, moduleId: number, body: { surchargePct: number; validFrom: string; validUntil: string }) =>
    request<import('./types').ModuleSurcharge>(`/api/modules/${moduleId}/surcharges`, { method: 'POST', body: JSON.stringify(body) }, token),

  updateModuleSurcharge: (token: string, surchargeId: number, body: { surchargePct: number; validFrom: string; validUntil: string }) =>
    request<import('./types').ModuleSurcharge>(`/api/module-surcharges/${surchargeId}`, { method: 'PUT', body: JSON.stringify(body) }, token),

  deleteModuleSurcharge: (token: string, surchargeId: number) =>
    request<void>(`/api/module-surcharges/${surchargeId}`, { method: 'DELETE' }, token),

  // --- Aanbiedingen (offers) — zie doelenboom_licentiemodel.md §9 ---

  offers: (token: string) => request<import('./types').Offer[]>('/api/offers', {}, token),

  createOffer: (
    token: string,
    body: {
      name: string;
      kind: import('./types').OfferKind;
      value: number | null;
      validFrom: string;
      validUntil: string;
      tierIds: number[];
    }
  ) => request<import('./types').Offer>('/api/offers', { method: 'POST', body: JSON.stringify(body) }, token),

  updateOffer: (
    token: string,
    offerId: number,
    body: {
      name: string;
      kind: import('./types').OfferKind;
      value: number | null;
      validFrom: string;
      validUntil: string;
      tierIds: number[];
    }
  ) => request<import('./types').Offer>(`/api/offers/${offerId}`, { method: 'PUT', body: JSON.stringify(body) }, token),

  deleteOffer: (token: string, offerId: number) => request<void>(`/api/offers/${offerId}`, { method: 'DELETE' }, token),

  // --- Zelfbedieningsaanvraag ("nieuw abonnement aanvragen") — de eerste vier
  // hieronder zijn bewust ONGEAUTHENTICEERD (geen token-param), zie
  // api/src/routes/subscriptions.ts. ---

  subscriptionTiers: () => request<import('./types').PublicTier[]>('/api/subscription-tiers'),

  subscriptionOffers: () => request<import('./types').Offer[]>('/api/subscription-offers'),

  subscriptionModules: () => request<import('./types').PublicModule[]>('/api/subscription-modules'),

  // moduleKeys: de aangevinkte modules — hun (op dit moment geldige) opslag
  // wordt meegerekend in tierPriceEur/subtotalEur (zie offers.ts computeOfferedPrice).
  subscriptionPriceForTier: (tierId: number, moduleKeys: string[] = []) =>
    request<import('./types').PriceQuote>(
      `/api/subscription-tiers/${tierId}/price${moduleKeys.length ? `?modules=${moduleKeys.map(encodeURIComponent).join(',')}` : ''}`
    ),

  createSubscriptionRequest: (body: {
    organizationName: string;
    applicantName: string;
    applicantEmail: string;
    applicantPhone?: string;
    password: string;
    tierId: number;
    moduleKeys: string[];
  }) =>
    request<{ tenantId: number; tenantSlug: string; requestId: number }>('/api/subscription-requests', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // --- Sysadmin-beheer van aanvragen/verlengingen ---

  subscriptionRequests: (token: string) =>
    request<import('./types').SubscriptionRequest[]>('/api/subscription-requests', {}, token),

  subscriptionOverview: (token: string) =>
    request<import('./types').TenantSubscriptionOverviewRow[]>('/api/subscription-requests/overview', {}, token),

  subscriptionRequestsPendingCount: (token: string) =>
    request<{ pendingRequests: number; upcomingRenewals: number }>('/api/subscription-requests/pending-count', {}, token),

  subscriptionRequestEvents: (token: string, requestId: number) =>
    request<import('./types').LicenseEvent[]>(`/api/subscription-requests/${requestId}/events`, {}, token),

  // Aanvrager-/contactgegevens corrigeren (naam/e-mail/telefoon) — raakt
  // bewust NIET het inlogaccount van de aanvrager. Elk veld is optioneel.
  updateSubscriptionRequestApplicant: (
    token: string,
    requestId: number,
    body: { applicantName?: string; applicantEmail?: string; applicantPhone?: string | null }
  ) =>
    request<import('./types').SubscriptionRequest>(
      `/api/subscription-requests/${requestId}`,
      { method: 'PUT', body: JSON.stringify(body) },
      token
    ),

  registerSubscriptionPayment: (token: string, requestId: number) =>
    request<import('./types').SubscriptionRequest>(
      `/api/subscription-requests/${requestId}/register-payment`,
      { method: 'POST' },
      token
    ),

  registerSubscriptionRenewal: (token: string, requestId: number) =>
    request<import('./types').SubscriptionRequest>(
      `/api/subscription-requests/${requestId}/register-renewal`,
      { method: 'POST' },
      token
    ),

  rejectSubscriptionRequest: (token: string, requestId: number, reason: string) =>
    request<import('./types').SubscriptionRequest>(
      `/api/subscription-requests/${requestId}/reject`,
      { method: 'POST', body: JSON.stringify({ reason }) },
      token
    ),

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

  // --- Auditlogboek (sysadmin-only, /audit-log): wie heeft welke boom bekeken
  // en welke tenant-instellingen zijn gewijzigd — zie db/init.sql audit_log. ---
  auditLog: (token: string) => request<import('./types').AuditLogEntry[]>('/api/audit-log', {}, token),
  // Excel-export gaat bewust NIET via de generieke request()-helper hierboven
  // (die verwacht altijd een JSON-body) maar via een losse fetch + blob, zelfde
  // patroon als downloadExport() in tree.html: de bestandsnaam komt uit de
  // Content-Disposition-header die de server meestuurt.
  downloadAuditLogExport: async (token: string): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetch(`${API_URL}/api/audit-log/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new ApiError(res.status, 'Export mislukt (HTTP ' + res.status + ')');
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const match = disposition.match(/filename="([^"]+)"/);
    return { blob, filename: match ? match[1] : 'auditlogboek.xlsx' };
  },

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

  // --- Juridische documenten (gebruiksvoorwaarden/privacyverklaring) — zie
  // api/src/routes/legal.ts. GET is bewust ongeauthenticeerd (ook zichtbaar
  // vóór inloggen), dus geen token-param. ---
  legalDocument: (type: 'terms' | 'privacy') =>
    request<import('./types').LegalDocument>(`/api/legal/${type}`, {}),

  termsAcceptanceStatus: (token: string) =>
    request<{ acceptanceRequired: boolean }>('/api/legal/terms/status', {}, token),

  acceptTerms: (token: string) =>
    request<{ accepted: true; version: string }>('/api/legal/terms/accept', { method: 'POST' }, token),
};

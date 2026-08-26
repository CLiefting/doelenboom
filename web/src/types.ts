export type TenantRoleName = 'admin' | 'gebruiker' | 'bezoeker';

export type UserTenantRole = {
  tenantId: number;
  tenantSlug: string;
  tenantName: string;
  role: TenantRoleName;
};

export type User = {
  id: number;
  email: string;
  isSysadmin: boolean;
  mustChangePassword: boolean;
  tenantRoles: UserTenantRole[];
};

export type UserSummary = {
  id: number;
  email: string;
  is_sysadmin: boolean;
  must_change_password: boolean;
  created_at: string;
  tenantRoles: UserTenantRole[];
};

export type TenantMember = { user_id: number; email: string; role: TenantRoleName };

export type DbStatDoelenboom = {
  id: number;
  slug: string;
  name: string;
  readOnly: boolean;
  wipeOnEmpty: boolean;
  elementCount: number;
  edgeCount: number;
  tagCount: number;
  orgUnitCount: number;
  importCount: number;
};

export type DbStatTenant = {
  id: number;
  slug: string;
  name: string;
  // Alleen nog de standaardwaarde voor nieuwe doelenbomen in deze tenant — de
  // daadwerkelijke auto-leegmaken-status staat per doelenboom (wipeOnEmpty
  // hierboven), zie db/init.sql bij doelenbomen.wipe_on_empty.
  defaultWipeOnEmpty: boolean;
  sessionTimeoutMinutes: number;
  doelenbomen: DbStatDoelenboom[];
};

export type SessionInfo = {
  sessionId: string;
  userId: number;
  email: string;
  isSysadmin: boolean;
  createdAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  active: boolean;
};

export type WipeCandidate = {
  tenant: { id: number; slug: string; name: string };
  doelenbomen: Array<{ id: number; slug: string; name: string; elementCount: number }>;
};

export type TenantSummary = {
  id: number;
  slug: string;
  name: string;
  wipe_on_empty: boolean;
  session_timeout_minutes: number;
  created_at: string;
  my_role?: TenantRoleName; // alleen aanwezig als niet-sysadmin dit ophaalt
  // "YYYY-MM-DD" of null (geen einddatum ingesteld/nooit verlopen) — zie
  // license.ts/routes/tenants.ts LICENSE_END_DATE_SELECT. Gebruikt door
  // TenantManagementPage om per tenant een kleurindicatie te tonen.
  license_end_date: string | null;
};

// Basisvorm zoals POST/PUT /api/doelenbomen die teruggeven (geen tenant-join
// nodig daar, de tenant is al bekend uit de URL/context). DoelenboomSummary
// (hieronder) is de rijkere vorm van GET /api/doelenbomen — mét tenant-info,
// nodig voor de picker die per tenant groepeert.
export type DoelenboomBase = {
  id: number;
  slug: string;
  name: string;
  read_only: boolean;
  wipe_on_empty: boolean;
  // null = actief. Zie license.ts/doelenboom_licentiemodel.md §5 — een
  // gearchiveerde doelenboom telt niet mee voor de tier-limiet.
  archivedAt: string | null;
  created_at: string;
};

export type DoelenboomSummary = DoelenboomBase & {
  tenant_id: number;
  tenant_slug: string;
  tenant_name: string;
};

// Eén rij in GET /api/doelenbomen/:id/member-roles — een tenant-lid met zijn
// tenant-brede rol, een eventuele override specifiek voor déze doelenboom
// (null = geen override, "gewoon de tenant-rol"), en de effectieve rol die
// daaruit volgt (overrideRole ?? tenantRole).
export type DoelenboomMemberRole = {
  userId: number;
  email: string;
  tenantRole: TenantRoleName;
  overrideRole: TenantRoleName | null;
  effectiveRole: TenantRoleName;
};

export type Element = {
  code: string;
  type: string;
  name: string;
  description: string;
  parent_text: string;
  kpi: string;
  taakveld: string;
  subtaakveld: string;
  sort_order: number;
};

export type Edge = { source: string; target: string; weight: string | null; toelichting: string };

export type ProjectStatus = {
  projectstatus: string;
  rag: string;
  toelichting: string;
  gerapporteerdOp: string | null;
  clusterPpt?: string;
};

export type ProductType = 'deliverable' | 'mijlpaal';

export type Product = {
  id: number;
  code: string;
  name: string;
  type: ProductType;
  omschrijving: string;
  pctGereed: number;
  verwachteDatum: string | null;
  werkelijkeDatum: string | null;
  opmerking: string;
};

// Activiteiten-planning binnen een project: anders dan Product hierboven (één
// los moment — verwachte/werkelijke datum) beslaat een activiteit een PERIODE
// (start t/m eind) — zie api/src/routes/activities.ts en tree.html
// (activitiesSectionHtml/activityGanttHtml, inklapbare Gantt-achtige sectie
// onder de tijdlijn). Puur informatief hier in de React-app zelf (er wordt
// niets van dit type in web/src/pages/*.tsx bewerkt — dat gebeurt allemaal
// binnen tree.html/de iframe), maar hoort bij TreeResponse hieronder.
export type Activity = {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
  omschrijving: string;
  // Alleen gezet voor via MS Project geïmporteerde activiteiten — de stabiele
  // Task-UID uit het bronbestand, gebruikt om een herimport te laten
  // bijwerken/verwijderen i.p.v. dubbele rijen aan te maken (tree.html:
  // computeMppImportPlan). null voor handmatig aangemaakte activiteiten.
  mppUid: string | null;
};

export type Tag = { code: string; name: string; categorie: string; omschrijving: string };
export type OrgUnit = { code: string; name: string; omschrijving: string };
export type ObOrgRelation = { org: string; relatietype: string; toelichting: string; status: string };

// Rol van de ingelogde gebruiker op déze specifieke doelenboom, en of diegene
// er (op dit moment) daadwerkelijk in mag schrijven — al server-side bepaald
// (tenant-rol, tenzij overruled via doelenboom_user_roles, plus read_only),
// zodat de frontend dit niet zelf hoeft te herleiden. Zie
// getEffectiveRoleForDoelenboom in api/src/rbac.ts.
export type TreeResponse = {
  columns: ColumnDef[];
  doelenboom: {
    id: number;
    slug: string;
    name: string;
    readOnly: boolean;
    effectiveRole: TenantRoleName;
    // canWrite: mag de "instellingen"-laag wijzigen (kolommen, doelenboom-
    // instellingen, Excel-import, tag-/org-catalogus) — alleen admin/sysadmin.
    canWrite: boolean;
    // canWriteContent: mag de "losse boom-inhoud" wijzigen (elementen,
    // relaties, tags/org-koppelingen op een element, projectstatus/producten/
    // activiteiten) — admin/sysadmin én de rol 'gebruiker'. Zie api/src/routes/tree.ts.
    canWriteContent: boolean;
    tenant: { id: number; slug: string; name: string };
  };
  elements: Element[];
  edges: Edge[];
  projectStatus: Record<string, ProjectStatus>;
  products: Record<string, Product[]>;
  activities: Record<string, Activity[]>;
  tags: Tag[];
  elementTags: Record<string, string[]>;
  orgUnits: OrgUnit[];
  obOrg: Record<string, ObOrgRelation[]>;
  // Module-keys die de licentie van deze tenant actief heeft (bv.
  // ['projecten']) — zie doelenboom_licentiemodel.md §3. projectStatus/
  // products hierboven zijn al server-side leeggemaakt als een module
  // ontbreekt (routes/tree.ts); dit veld is voor de UI om knoppen als
  // "+ Product" te verbergen i.p.v. te tonen-maar-te-laten-mislukken.
  activeModules: string[];
  // Licentie-einddatum van de tenant verstreken? (zie license.ts
  // isLicenseExpired, doelenboom_licentiemodel.md) — canWrite hierboven houdt
  // hier al rekening mee (false als verlopen, behalve voor sysadmin); dit
  // veld is voor de UI om een watermerk te tonen ("Licentie verlopen voor
  // {tenant}", zie tree.html).
  licenseExpired: boolean;
};

// --- Licentiemodel (zie doelenboom_licentiemodel.md) ---

export type Tier = {
  id: number;
  name: string;
  maxAdmins: number;
  maxBomen: number;
  sortOrder: number;
};

export type ModuleDef = {
  id: number;
  key: string;
  name: string;
  description: string;
};

export type TenantLicense = {
  tier: Tier | null;
  activeModules: string[];
  // "YYYY-MM-DD" of null (geen einddatum ingesteld/nooit verlopen). expired
  // is puur afgeleid, al server-side berekend (license.ts getTenantLicense).
  endDate: string | null;
  expired: boolean;
  usage: {
    activeAdmins: number;
    activeBomen: number;
    lifetimeBomenAangemaakt: number;
  };
};

export type ImportSummary = {
  id: number;
  filename: string;
  uploaded_at: string;
  status: string;
  published_at: string | null;
};

export type ImportReport = {
  filename: string;
  format?: 'oud' | 'nieuw';
  sheetsFound: string[];
  sheetsMissing: string[];
  counts: Record<string, number>;
  warnings: string[];
  errors: string[];
};

export type ImportDetail = ImportSummary & {
  doelenboom_id: number;
  report_json: ImportReport;
};

// Systeembrede mededeling (bv. onderhoudsaankondiging) — zie
// api/src/routes/announcement.ts en db/init.sql system_announcements. Er is
// altijd precies één rij; GET is ongeauthenticeerd (ook zichtbaar op de
// inlogpagina), PUT is sysadmin-only.
export type SystemAnnouncement = {
  message: string;
  active: boolean;
  updatedAt: string | null;
};

// Eén kolom in een kolomconfiguratie (tenant-default óf één specifieke
// doelenboom, zie docs/kolommen-configuratie-ontwerp.md) — zelfde vorm als
// ColumnDef in api/src/columnConfig.ts. `id` ontbreekt bij een nog niet
// opgeslagen, lokaal toegevoegde rij in de editor (zie ColumnConfigEditor).
export type ColumnDef = {
  id?: number;
  position: number;
  typeName: string;
  title: string;
  subtitle: string;
  color: string;
  isNarrow: boolean;
  nodeFontSize: number | null;
  isProjectRole: boolean;
  relationLabelToNext: string | null;
};

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
  // Moet de gebruiker eerst de geldende gebruiksvoorwaarden (opnieuw)
  // accepteren voordat de rest van de app te gebruiken is? Zie
  // TermsAcceptanceGate.tsx (mirrort het mustChangePassword-patroon
  // hierboven) en api/src/legal.ts (needsTermsAcceptance).
  termsAcceptanceRequired: boolean;
  tenantRoles: UserTenantRole[];
};

// Eén juridisch document (gebruiksvoorwaarden of privacyverklaring) zoals
// geserveerd door GET /api/legal/:type — zie api/src/legal.ts. content volgt
// een lichte, zelfbedachte Markdown-achtige conventie ('## '/'### '/'- ',
// verder platte alinea's) die LegalPage.tsx regel-voor-regel rendert.
export type LegalDocument = {
  id: number;
  docType: 'terms' | 'privacy';
  version: string;
  effectiveDate: string;
  publishedAt: string | null;
  status: 'draft' | 'published';
  requiresReacceptance: boolean;
  content: string;
};

// GET/PUT /api/app-settings (sysadmin-only, app-breed, zie
// api/src/appSettings.ts) — op dit moment alleen de inlog-blokkade
// (auth.ts POST /login), instelbaar via AccountManagementPage.
export type AppSettings = {
  maxFailedLoginAttempts: number;
  loginLockoutMinutes: number;
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
  // Standaardwaarde voor nieuwe doelenbomen in deze tenant — de daadwerkelijke
  // aan/uit-schakelaar voor de nachtelijke Excel-back-up staat per doelenboom
  // (DoelenboomBase.nightly_export_enabled hieronder), zelfde patroon als
  // wipe_on_empty hierboven.
  nightly_export_enabled: boolean;
  // null = open toegang uit (huidig gedrag: alleen expliciete leden). Gezet
  // op een rol = elk account met een login krijgt minstens die rol binnen
  // deze tenant, ook zonder eigen lidmaatschap — zie api/src/rbac.ts
  // getTenantRole. Bedoeld voor bv. de Demo-tenant.
  open_access_role: TenantRoleName | null;
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
  // Of deze doelenboom meegenomen wordt in de nachtelijke Excel-back-up (zie
  // db/init.sql, api/src/scripts/exportAllDoelenbomen.ts). Default true,
  // instelbaar via DoelenboomEditRow in TenantManagementPage.
  nightly_export_enabled: boolean;
  // Drempel (in dagen) voor de 'verouderd'-markering op projectelementen —
  // zie db/migrations/0020_project_status_review.sql en isStale() in
  // tree.html. Instelbaar via DoelenboomEditRow in TenantManagementPage.
  staleAfterDays: number;
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

// Eén rij in GET /api/tenants/:tenantId/doelenboom-templates (zie
// api/src/doelenboomTemplates.ts) — tenantId null = systeembreed sjabloon
// (bv. "Batenboom"), gevuld = eigen sjabloon van die tenant. tenantName is
// alleen gevuld door GET /api/doelenboom-templates (het aggregerende
// Sjablonenbeheer-scherm, dat sjablonen van meerdere tenants tegelijk
// toont) — de per-tenant kiezer (.../tenants/:tenantId/doelenboom-templates)
// laat 'm weg, want daar is de tenant al bekend uit de context.
export type DoelenboomTemplateSummary = {
  id: number;
  tenantId: number | null;
  tenantName?: string | null;
  name: string;
  description: string;
  createdAt: string;
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
export type DuurEenheid = 'd' | 'w' | 'm' | 'y';

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
  // Doorlooptijd om dit planning item te realiseren, puur informatief — null
  // als (nog) niet ingeschat. duurEenheid heeft altijd een waarde maar is dan
  // irrelevant. Zie api/src/routes/products.ts.
  duur: number | null;
  duurEenheid: DuurEenheid;
  // Vrije numerieke inschatting van de waarde die dit oplevert (bv. story
  // points of een score), bewust zonder vaste eenheid/valuta.
  businessValue: number | null;
  // Uiterste opleverdatum, los van verwachteDatum hierboven (dat is de
  // PLANNING; dit is de harde grens). Puur informatief.
  deadline: string | null;
};

// Afhankelijkheid tussen twee planning items (deliverables/mijlpalen) binnen
// hetzelfde project — simpeler dan ActivityDependency hieronder: een
// planning item heeft geen startdatum (alleen een verwachte/werkelijke
// opleverdatum, één moment), dus geen type/lagDays. predecessorId/
// successorId zijn Product.id-waarden. Zie api/src/routes/products.ts.
export type ProductDependency = {
  id: number;
  predecessorId: number;
  successorId: number;
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
  // Bij MS Project-import overgenomen van de taak z'n Milestone-vlag (ook
  // handmatig te zetten) — bepaalt of de Gantt-balk (tree.html:
  // activityGanttHtml) een ruit-icoon toont i.p.v. een balkje van één dag.
  isMilestone: boolean;
  // Het WBS-nummer uit MS Project (bv. "2.1"), puur informatief — getoond
  // tussen haakjes vóór de taaknaam. null voor handmatig aangemaakte
  // activiteiten.
  wbs: string | null;
  // Bij MS Project-import overgenomen van de taak z'n Summary-vlag
  // ("fase"/samenvattende taak, ook handmatig te zetten) — toont in de Gantt
  // een dunnere balk met eindmarkeringen i.p.v. een gewone balk.
  isSummary: boolean;
};

// Afhankelijkheid tussen twee activiteiten binnen hetzelfde project — denk
// aan MS Project: successorId hangt af van predecessorId volgens 'type' (FS
// = Finish-Start, de default en verreweg het gebruikelijkste; SS/FF/SF
// bestaan voor volledigheid). lagDays: vertraging (positief) of overlap/
// voorsprong (negatief) in dagen, puur informatief — zie
// api/src/routes/activities.ts en tree.html (activityGanttHtml tekent de
// pijl). predecessorId/successorId zijn Activity.id-waarden.
export type ActivityDependencyType = 'FS' | 'SS' | 'FF' | 'SF';
export type ActivityDependency = {
  id: number;
  predecessorId: number;
  successorId: number;
  type: ActivityDependencyType;
  lagDays: number;
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
  productDependencies: Record<string, ProductDependency[]>;
  activities: Record<string, Activity[]>;
  dependencies: Record<string, ActivityDependency[]>;
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
  // Zie db/migrations/0018_evaluatie_tier.sql — generieke velden voor een
  // "gratis proeftier" zoals Evaluatie. trialDays null = standaard proefduur
  // (14 dagen, zie api/src/subscriptions.ts TRIAL_DAYS).
  trialDays: number | null;
  allModulesIncluded: boolean;
};

// Eén prijsperiode van een tier — een abonnement heeft door de tijd heen
// meerdere prijzen (bv. € 125/jaar in 2026, een ander tarief in 2027), dus
// dit is een eigen geschiedenis i.p.v. een enkel prijsveld op Tier zelf. Zie
// doelenboom_licentiemodel.md §9.
export type TierPrice = {
  id: number;
  tierId: number;
  priceEur: string;
  validFrom: string;
  validUntil: string;
};

// Publieke tier-listing (GET /api/subscription-tiers) — Tier + de op dit
// moment geldige prijs (null-tiers worden al server-side weggefilterd, dus
// dit veld is hier altijd gezet).
export type PublicTier = Tier & { currentPriceEur: string };

export type ModuleDef = {
  id: number;
  key: string;
  name: string;
  description: string;
};

// Eén opslagperiode van een module (% van de tier-basisprijs) — zelfde
// geschiedenis-principe als TierPrice hierboven. Zie doelenboom_licentiemodel.md §3/§9.
export type ModuleSurcharge = {
  id: number;
  moduleId: number;
  surchargePct: string;
  validFrom: string;
  validUntil: string;
};

// Publieke module-listing (GET /api/subscription-modules) — ModuleDef + de op
// dit moment geldige opslag (null = nog niet bepaald, telt dan niet mee in
// de aanvraagprijs).
export type PublicModule = ModuleDef & { currentSurchargePct: string | null };

export type OfferKind = 'percentage' | 'fixed_amount' | 'btw_vrij';

export type Offer = {
  id: number;
  name: string;
  kind: OfferKind;
  value: string | null;
  validFrom: string;
  validUntil: string;
  tierIds: number[];
};

export type PriceQuoteModuleLine = {
  moduleKey: string;
  moduleName: string;
  surchargePct: number;
  amountEur: number;
};

export type PriceQuote = {
  tierPriceEur: number | null;
  moduleSurcharges: PriceQuoteModuleLine[];
  subtotalEur: number | null;
  offer: Offer | null;
  finalPriceEur: number | null;
  btwVrij: boolean;
};

export type SubscriptionRequestStatus = 'proef' | 'actief' | 'afgewezen';

export type SubscriptionRequest = {
  id: number;
  tenantId: number;
  tenantSlug: string;
  tenantName: string;
  tierId: number | null;
  tierName: string | null;
  organizationName: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string | null;
  requestedModules: string[];
  status: SubscriptionRequestStatus;
  requestedAt: string;
  priceAtRequest: string | null;
  contractEndDate: string | null;
  licenseEndDate: string | null;
  paymentRegisteredAt: string | null;
  rejectedAt: string | null;
  rejectedReason: string | null;
};

// Eén rij per tenant (ook tenants zonder zelfbedieningsaanvraag) — voor het
// sorteerbare abonnementenoverzicht naast Tenantbeheer, zie
// SubscriptionOverviewPage.tsx / GET /api/subscription-requests/overview.
export type TenantSubscriptionOverviewRow = {
  tenantId: number;
  tenantSlug: string;
  tenantName: string;
  // null als deze tenant geen zelfbedieningsaanvraag heeft (handmatig
  // aangemaakt) — bepaalt of bewerken van aanvragergegevens en betaling/
  // verlenging registreren mogelijk is.
  requestId: number | null;
  tierId: number | null;
  tierName: string | null;
  licenseEndDate: string | null;
  status: SubscriptionRequestStatus | null;
  applicantName: string | null;
  applicantEmail: string | null;
  applicantPhone: string | null;
  requestedAt: string | null;
};

export type LicenseEvent = {
  id: number;
  eventType: string;
  detail: Record<string, unknown>;
  performedBy: number | null;
  performedByEmail: string | null;
  createdAt: string;
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

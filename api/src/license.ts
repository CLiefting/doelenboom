import { PoolClient } from 'pg';
import { pool } from './db.js';
import { logAuditEvent } from './auditLog.js';

// Licentiemodel — zie doelenboom_licentiemodel.md en
// doelenboom_licentie_datamodel.drawio in het Doelenboom-project voor het
// volledige ontwerp, en db/migrations/0002_licenses.sql voor de tabellen.
// Bundelt alle databasetoegang tot tiers/modules/tenant_modules en de
// bijbehorende limiet-enforcement, gebruikt door routes/licenses.ts,
// routes/tenants.ts (admin/editor-limiet, samen tegen max_editors), routes/
// doelenbomen.ts (bomen-limiet) en rbac.ts (requireModule, voor de
// "Projecten"-module-gating).

// Prijs staat sinds 30 augustus 2026 NIET meer op de tier zelf — een
// abonnement heeft meerdere prijzen door de tijd heen (bv. € 125/jaar in
// 2026, een ander tarief in 2027), dus dat is een eigen geschiedenis-tabel
// geworden. Zie tierPrices.ts (tier_prices) voor het prijsbeheer, en
// moduleSurcharges.ts (module_surcharges) voor de module-opslagpercentages,
// die om dezelfde reden ook een eigen geschiedenis hebben.
export interface Tier {
  id: number;
  name: string;
  maxEditors: number;
  maxBomen: number;
  sortOrder: number;
  // Zie db/migrations/0018_evaluatie_tier.sql: generieke velden voor een
  // "gratis proeftier" zoals Evaluatie, i.p.v. dit hard te coderen als
  // uitzondering voor één specifieke tiernaam. trialDays null = gebruik de
  // standaard TRIAL_DAYS uit subscriptions.ts.
  trialDays: number | null;
  allModulesIncluded: boolean;
}

export interface ModuleDef {
  id: number;
  key: string;
  name: string;
  description: string;
}

export interface TenantLicense {
  tier: Tier | null;
  activeModules: string[];
  // Licentie-einddatum (zie doelenboom_licentiemodel.md, db/migrations/
  // 0003_license_expiry.sql) — "YYYY-MM-DD" of null (geen einddatum
  // ingesteld/nooit verlopen). expired is de daadwerkelijke afdwingingsstatus
  // (isLicenseExpired) — gemakshalve al hier meegegeven zodat de frontend 'm
  // niet zelf hoeft te herleiden.
  endDate: string | null;
  expired: boolean;
  // Losse, informatieve velden voor de opzeg-regel (zie
  // db/migrations/0035_subscription_cancellation.sql en isLicenseExpired
  // hieronder): datePassed = endDate is puur kalendermatig al voorbij (kan
  // dus true zijn terwijl expired nog false is — een lopend, niet-opgezegd
  // abonnement waarvan de einddatum is gepasseerd blijft schrijfbaar).
  datePassed: boolean;
  cancelledAt: string | null;
  // Bepaalt of de opzeg-regel hierboven überhaupt van toepassing is: 'proef'
  // en 'afgewezen' sluiten onvoorwaardelijk op hun (eventueel kunstmatig
  // vervroegde) einddatum, ongeacht cancelledAt — zie isLicenseExpired. null =
  // handmatig door een sysadmin aangemaakte tenant, zonder subscription_
  // requests-rij (volgt dezelfde opzeg-regel als 'actief').
  subscriptionRequestStatus: 'proef' | 'actief' | 'afgewezen' | null;
  // Volledige per-module toewijzingen (start-/einddatum, opzegging) — zie
  // TenantModuleAssignment/getTenantModuleAssignments hieronder en
  // db/migrations/0036_tenant_module_dates.sql. activeModules hierboven blijft
  // de simpele, puur boolean lijst (voor tree.ts-gating e.d.); dit is de
  // volledige data voor het beheerscherm.
  moduleAssignments: TenantModuleAssignment[];
  usage: {
    activeEditors: number;
    activeBomen: number;
    lifetimeBomenAangemaakt: number;
  };
}

// Aparte foutklasse (i.p.v. een generieke Error) zodat route-handlers 'm kunnen
// onderscheiden van onverwachte/technische fouten en er altijd een 403/409 met
// de eigen boodschap van maken i.p.v. een generieke 500.
export class LicenseLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LicenseLimitError';
  }
}

const TIER_SELECT_FIELDS =
  'id, name, max_editors as "maxEditors", max_bomen as "maxBomen", sort_order as "sortOrder", ' +
  'trial_days as "trialDays", all_modules_included as "allModulesIncluded"';
const MODULE_SELECT_FIELDS = 'id, key, name, description';

// --- Tiers: door sysadmins vrij te beheren (CRUD), zie routes/licenses.ts. ---

export async function listTiers(): Promise<Tier[]> {
  const r = await pool.query(`select ${TIER_SELECT_FIELDS} from tiers order by sort_order, name`);
  return r.rows;
}

export async function createTier(input: {
  name: string;
  maxEditors: number;
  maxBomen: number;
  sortOrder: number;
  trialDays?: number | null;
  allModulesIncluded?: boolean;
}): Promise<Tier> {
  const r = await pool.query(
    `insert into tiers (name, max_editors, max_bomen, sort_order, trial_days, all_modules_included)
     values ($1,$2,$3,$4,$5,$6)
     returning ${TIER_SELECT_FIELDS}`,
    [
      input.name,
      input.maxEditors,
      input.maxBomen,
      input.sortOrder,
      input.trialDays ?? null,
      input.allModulesIncluded ?? false,
    ]
  );
  return r.rows[0];
}

export async function updateTier(
  id: number | string,
  input: {
    name?: string;
    maxEditors?: number;
    maxBomen?: number;
    sortOrder?: number;
    trialDays?: number | null;
    hasTrialDays?: boolean;
    allModulesIncluded?: boolean;
  }
): Promise<Tier | null> {
  const r = await pool.query(
    `update tiers set
       name = coalesce($1, name),
       max_editors = coalesce($2, max_editors),
       max_bomen = coalesce($3, max_bomen),
       sort_order = coalesce($4, sort_order),
       trial_days = case when $5 then $6 else trial_days end,
       all_modules_included = coalesce($7, all_modules_included),
       updated_at = now()
     where id = $8
     returning ${TIER_SELECT_FIELDS}`,
    [
      input.name ?? null,
      input.maxEditors ?? null,
      input.maxBomen ?? null,
      input.sortOrder ?? null,
      !!input.hasTrialDays,
      input.trialDays ?? null,
      input.allModulesIncluded ?? null,
      id,
    ]
  );
  return r.rows[0] ?? null;
}

// Verwijderen mag altijd (geen "nog in gebruik"-check): tenants die deze tier
// hadden vallen terug op tier_id = null (onbeperkt) via "on delete set null"
// op tenants.tier_id — zie db/migrations/0002_licenses.sql. Een sysadmin die
// per ongeluk een tier verwijdert raakt zo nooit tenants kwijt.
export async function deleteTier(id: number | string): Promise<boolean> {
  const r = await pool.query('delete from tiers where id = $1 returning id', [id]);
  return (r.rowCount ?? 0) > 0;
}

// --- Modules: catalogus, ook door sysadmins vrij te beheren. ---

export async function listModules(): Promise<ModuleDef[]> {
  const r = await pool.query(`select ${MODULE_SELECT_FIELDS} from modules order by name`);
  return r.rows;
}

export async function createModule(input: { key: string; name: string; description: string }): Promise<ModuleDef> {
  const r = await pool.query(
    `insert into modules (key, name, description) values ($1,$2,$3) returning ${MODULE_SELECT_FIELDS}`,
    [input.key, input.name, input.description]
  );
  return r.rows[0];
}

export async function updateModule(
  id: number | string,
  input: { name?: string; description?: string }
): Promise<ModuleDef | null> {
  // "key" is bewust niet wijzigbaar via update: code (hasModule/requireModule-
  // aanroepen) verwijst naar de key als stabiele identifier — die laten
  // veranderen zou bestaande module-gating elders in de code stilletjes
  // kunnen breken. Een key hernoemen = verwijderen + opnieuw aanmaken, met
  // bewuste her-koppeling van tenant_modules.
  const r = await pool.query(
    `update modules set
       name = coalesce($1, name),
       description = coalesce($2, description),
       updated_at = now()
     where id = $3
     returning ${MODULE_SELECT_FIELDS}`,
    [input.name ?? null, input.description ?? null, id]
  );
  return r.rows[0] ?? null;
}

export async function deleteModule(id: number | string): Promise<boolean> {
  const r = await pool.query('delete from modules where id = $1 returning id', [id]);
  return (r.rowCount ?? 0) > 0;
}

// --- Per-tenant licentie: tier-toewijzing, modules, gebruik. ---

// Sinds de prijsstrategie-herziening van 7 september 2026 (zie
// doelenboom_licentiemodel.md §5 v3): 'admin' én 'editor' (tot dan
// 'gebruiker' geheten) tellen SAMEN tegen de licentielimiet — 'bezoeker'
// blijft onbeperkt. Naam bewust "Editors" (niet "ActiveAdmins") om dat
// duidelijk te maken; de kolom heet nu ook tiers.max_editors.
async function countActiveEditors(tenantId: number | string): Promise<number> {
  const r = await pool.query(
    `select count(*)::int as n from tenant_users where tenant_id = $1 and role in ('admin', 'editor')`,
    [tenantId]
  );
  return r.rows[0].n;
}

async function countActiveBomen(tenantId: number | string): Promise<number> {
  const r = await pool.query(
    'select count(*)::int as n from doelenbomen where tenant_id = $1 and archived_at is null',
    [tenantId]
  );
  return r.rows[0].n;
}

// Herbruikbare "is deze module-toewijzing nu actief"-voorwaarde — zelfde
// polis-model als isLicenseExpired/closesUnconditionallyOnEndDate hierboven,
// maar dan voor een module ("optie") in plaats van het hele abonnement (zie
// db/migrations/0036_tenant_module_dates.sql): nog niet gestart (start_date
// in de toekomst) = niet actief; opgezegd ÉN einddatum gepasseerd = niet
// actief; anders actief — een gepasseerde einddatum zónder opzegging maakt
// een module dus NIET inactief, precies zoals bij het abonnement zelf.
const TENANT_MODULE_ACTIVE_SQL = `
  tm.start_date <= current_date
  and not (tm.cancelled_at is not null and tm.end_date is not null and tm.end_date < current_date)
`;

export async function getActiveModuleKeys(tenantId: number | string): Promise<string[]> {
  const r = await pool.query(
    `select m.key from tenant_modules tm join modules m on m.id = tm.module_id
     where tm.tenant_id = $1 and ${TENANT_MODULE_ACTIVE_SQL}`,
    [tenantId]
  );
  return r.rows.map((row) => row.key as string);
}

export interface TenantModuleAssignment {
  key: string;
  name: string;
  startDate: string;
  endDate: string | null;
  cancelledAt: string | null;
  active: boolean;
}

// Alle module-TOEWIJZINGEN van een tenant (in tegenstelling tot
// getActiveModuleKeys hierboven: ook een nog niet gestarte of al opgezegde
// toewijzing, met de volledige data — voor het beheerscherm in Klantbeheer,
// zie routes/customerManagement.ts/KlantbeheerPage.tsx). Modules zonder
// toewijzing (nooit geactiveerd voor deze tenant) staan er niet in.
export async function getTenantModuleAssignments(tenantId: number | string): Promise<TenantModuleAssignment[]> {
  const r = await pool.query(
    `select m.key, m.name,
            to_char(tm.start_date, 'YYYY-MM-DD') as "startDate",
            to_char(tm.end_date, 'YYYY-MM-DD') as "endDate",
            tm.cancelled_at as "cancelledAt",
            (${TENANT_MODULE_ACTIVE_SQL}) as active
     from tenant_modules tm join modules m on m.id = tm.module_id
     where tm.tenant_id = $1
     order by m.name`,
    [tenantId]
  );
  return r.rows;
}

export async function hasModule(tenantId: number | string, moduleKey: string): Promise<boolean> {
  const r = await pool.query(
    `select 1 from tenant_modules tm join modules m on m.id = tm.module_id
     where tm.tenant_id = $1 and m.key = $2 and ${TENANT_MODULE_ACTIVE_SQL}`,
    [tenantId, moduleKey]
  );
  return r.rows.length > 0;
}

// Bepaalt of het abonnement 'onvoorwaardelijk' op zijn (eventueel kunstmatig
// vervroegde) einddatum sluit — proef en afgewezen, zie isLicenseExpired
// hieronder — i.p.v. pas ná een expliciete opzegging.
function closesUnconditionallyOnEndDate(requestStatus: string | null): boolean {
  return requestStatus === 'proef' || requestStatus === 'afgewezen';
}

export async function getTenantLicense(tenantId: number | string): Promise<TenantLicense | null> {
  const tenantRow = await pool.query(
    `select t.tier_id, t.lifetime_trees_created,
            to_char(t.license_end_date, 'YYYY-MM-DD') as end_date,
            (t.license_end_date is not null and t.license_end_date < current_date) as date_passed,
            t.subscription_cancelled_at as cancelled_at,
            sr.status as request_status
     from tenants t
     left join subscription_requests sr on sr.tenant_id = t.id
     where t.id = $1`,
    [tenantId]
  );
  if (tenantRow.rows.length === 0) return null;
  const row = tenantRow.rows[0];
  const tierId = row.tier_id as number | null;
  const tier =
    tierId == null
      ? null
      : ((await pool.query(`select ${TIER_SELECT_FIELDS} from tiers where id = $1`, [tierId])).rows[0] ?? null);
  const [activeModules, moduleAssignments, activeEditors, activeBomen] = await Promise.all([
    getActiveModuleKeys(tenantId),
    getTenantModuleAssignments(tenantId),
    countActiveEditors(tenantId),
    countActiveBomen(tenantId),
  ]);
  const datePassed = row.date_passed as boolean;
  const cancelledAt = (row.cancelled_at as string | null) ?? null;
  const requestStatus = (row.request_status as 'proef' | 'actief' | 'afgewezen' | null) ?? null;
  const expired = datePassed && (closesUnconditionallyOnEndDate(requestStatus) || cancelledAt != null);
  return {
    tier,
    activeModules,
    endDate: row.end_date,
    expired,
    datePassed,
    cancelledAt,
    subscriptionRequestStatus: requestStatus,
    moduleAssignments,
    usage: {
      activeEditors,
      activeBomen,
      lifetimeBomenAangemaakt: row.lifetime_trees_created,
    },
  };
}

// Standaard-einddatum bij het aanmaken van een NIEUWE tenant (zie
// routes/tenants.ts POST /) of een zelfbedieningscontract (subscriptions.ts
// registerPayment/registerRenewal): einde van de startmaand + `months`
// maanden, dus een licentie die netjes op een maandgrens afloopt.
// Bijvoorbeeld: aangemaakt op 25 augustus 2026, months=12 -> einde van
// augustus 2026 (31 aug) -> +12 maanden -> 31 augustus 2027. `months`
// default 12 (jaarlicentie, ongewijzigd gedrag voor routes/tenants.ts en
// jaarlijkse zelfbedieningscontracten) — sinds de maandelijkse facturatie
// van 7 september 2026 (doelenboom_licentiemodel.md §9.2 v3) geeft
// subscriptions.ts hier ook months=1 door voor een maandcontract. Werkt op
// UTC-kalenderdata (los van tijdzone van de server) omdat het hier om een
// kalenderdatum gaat, geen tijdstip. Date.UTC(jaar, maand+1, 0) is de
// laatste dag van "maand" (dag 0 van de volgende maand rolt automatisch
// terug) — hetzelfde trucje voor de maand-overflow bij +N maanden (bv. 29
// feb in een schrikkeljaar +12 maanden rolt netjes door naar 1 maart het
// jaar erna, er bestaat dan geen 29 feb).
export function computeDefaultLicenseEndDate(from: Date, months = 12): string {
  const endOfCreationMonth = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0));
  const totalMonths = endOfCreationMonth.getUTCMonth() + months;
  const endDate = new Date(
    Date.UTC(
      endOfCreationMonth.getUTCFullYear() + Math.floor(totalMonths / 12),
      totalMonths % 12,
      endOfCreationMonth.getUTCDate()
    )
  );
  return endDate.toISOString().slice(0, 10);
}

// Zie rbac.ts requireWritableDoelenboom: dezelfde enforcement-plek als de
// bestaande doelenboom.read_only-check, dus zonder apart handhavingspad.
// null (geen einddatum ingesteld) = nooit verlopen, ook de staat waarin elke
// tenant van vóór deze feature terechtkomt (db/migrations/0003_license_expiry.sql).
//
// Sinds db/migrations/0035_subscription_cancellation.sql (Charles' verzoek,
// 6 september 2026: "pas als deze opgezegd is, gaat deze op einddatum op
// readonly", net als een verzekeringspolis) is het passeren van de einddatum
// alléén voor 'proef' en 'afgewezen' nog onvoorwaardelijk (zie
// closesUnconditionallyOnEndDate hierboven — subscriptions.ts zet bij een
// afwijzing license_end_date bewust op gisteren om meteen te blokkeren, en
// een proefperiode MOET vanzelf sluiten, er is dan nooit een opzegging). Voor
// elk ander geval — 'actief', of een handmatig door een sysadmin aangemaakte
// tenant zonder subscription_requests-rij — is de tenant pas verlopen als het
// abonnement ook daadwerkelijk is opgezegd (subscription_cancelled_at gezet,
// zie setSubscriptionCancelled hieronder); zonder opzegging blijft zo'n
// tenant gewoon schrijfbaar, ook ver na de kalendermatige einddatum (zie
// getTenantLicense/customerManagement.ts se health-route voor de "risico"-
// signalering die daar wél bij hoort).
export async function isLicenseExpired(tenantId: number | string): Promise<boolean> {
  const r = await pool.query(
    `select
       (t.license_end_date is not null and t.license_end_date < current_date) as date_passed,
       t.subscription_cancelled_at is not null as cancelled,
       sr.status as request_status
     from tenants t
     left join subscription_requests sr on sr.tenant_id = t.id
     where t.id = $1`,
    [tenantId]
  );
  const row = r.rows[0];
  if (!row || !row.date_passed) return false;
  if (closesUnconditionallyOnEndDate(row.request_status)) return true;
  return row.cancelled;
}

// Is deze tenant beëindigd (tenants.terminated_at gezet, zie
// tenantRetention.ts terminateTenant)? Net als isLicenseExpired hierboven de
// enforcement-plek in rbac.ts — maar strenger: een verlopen licentie maakt de
// tenant read-only voor iedereen die al toegang had; een beëindigde tenant is
// voor gewone leden helemaal ontoegankelijk/onzichtbaar geworden en alleen
// nog (read-only) voor een sysadmin te raadplegen, zie rbac.ts.
export async function isTenantTerminated(tenantId: number | string): Promise<boolean> {
  const r = await pool.query('select terminated_at is not null as terminated from tenants where id = $1', [tenantId]);
  return r.rows[0]?.terminated ?? false;
}

// Sysadmin-only (zie routes/licenses.ts) — een licentie verlengen/wijzigen,
// of de einddatum wissen (endDate = null, "nooit verlopen"). Geen
// limiet-check nodig hier (in tegenstelling tot setTenantTier): een
// einddatum wijzigen kan een tenant hooguit read-only maken of dat weer
// opheffen, nooit een tier-limiet overschrijden.
//
// actorUserId: wie deze wijziging deed — gelogd als 'tenant_subscription_changed'
// (audit_log), zelfde diff-vorm {from, to} als tenant_settings_changed in
// routes/tenants.ts. Ook: een gewijzigde einddatum zet de
// verlengingsherinnering-vlag terug naar null (zie licenseRenewalReminder.ts)
// zodat een nieuwe/verlengde einddatum weer zijn eigen herinneringscyclus
// krijgt i.p.v. stil te blijven omdat de vórige einddatum al een herinnering
// kreeg.
export async function setTenantLicenseEndDate(
  tenantId: number | string,
  endDate: string | null,
  actorUserId: number | string
): Promise<void> {
  const before = await pool.query(
    `select to_char(license_end_date, 'YYYY-MM-DD') as end_date from tenants where id = $1`,
    [tenantId]
  );
  const beforeEndDate = before.rows[0]?.end_date ?? null;
  await pool.query(
    'update tenants set license_end_date = $1, license_renewal_reminder_sent_at = null where id = $2',
    [endDate, tenantId]
  );
  if (beforeEndDate !== endDate) {
    await logAuditEvent({
      eventType: 'tenant_subscription_changed',
      userId: actorUserId,
      tenantId,
      role: null,
      detail: { changes: { license_end_date: { from: beforeEndDate, to: endDate } } },
    });
  }
}

// Abonnement opzeggen/opzegging intrekken — zie db/migrations/
// 0035_subscription_cancellation.sql en isLicenseExpired hierboven voor de
// afdwingingsregel die dit aanstuurt (net als bij een polis: pas ná deze
// opzegging maakt het passeren van license_end_date de tenant read-only).
// cancelled: true zet subscription_cancelled_at op "nu" (de datum waarop de
// opzegging is geregistreerd — de bestaande license_end_date blijft
// ongewijzigd, dát is nog altijd de datum waarop de opzegging ingaat); false
// trekt een eerdere opzegging in (bv. de klant bedenkt zich, of Charles heeft
// 'm per ongeluk gezet) door het veld weer op null te zetten. Zonder effect
// (en dus geen extra logregel) als de gevraagde staat al de huidige is.
export async function setSubscriptionCancelled(
  tenantId: number | string,
  cancelled: boolean,
  actorUserId: number | string
): Promise<void> {
  const before = await pool.query('select subscription_cancelled_at from tenants where id = $1', [tenantId]);
  const beforeValue = (before.rows[0]?.subscription_cancelled_at as string | null) ?? null;
  const wasCancelled = beforeValue != null;
  if (wasCancelled === cancelled) return;
  const newValue = cancelled ? new Date().toISOString() : null;
  await pool.query('update tenants set subscription_cancelled_at = $1 where id = $2', [newValue, tenantId]);
  await logAuditEvent({
    eventType: 'tenant_subscription_changed',
    userId: actorUserId,
    tenantId,
    role: null,
    detail: { changes: { subscription_cancelled_at: { from: beforeValue, to: newValue } } },
  });
}

async function tenantModuleId(moduleKey: string): Promise<number> {
  const moduleRow = await pool.query('select id from modules where key = $1', [moduleKey]);
  if (!moduleRow.rows[0]) throw new Error(`Module "${moduleKey}" bestaat niet.`);
  return moduleRow.rows[0].id;
}

// Simpele aan/uit-schakelaar (zie TenantLicensePanel.tsx en de vinkjes in
// KlantbeheerPage.tsx) — voor de fijnmazige start-/einddatum en losse
// opzegging per module ("optie", Charles' verzoek van 6 september 2026), zie
// setTenantModuleStartDate/setTenantModuleEndDate/setTenantModuleCancelled
// hieronder. active=true (her)activeert altijd een SCHONE toewijzing (start
// vandaag, geen einddatum, niet opgezegd) — ook als er al een (inmiddels
// verlopen/opgezegde) rij bestond, zodat "aanvinken" nooit stil blijft hangen
// op een oude einddatum/opzegging. active=false verwijdert de toewijzing
// volledig en onmiddellijk (in tegenstelling tot opzeggen, dat pas op de
// einddatum ingaat) — voor het direct corrigeren van een vergissing.
export async function setTenantModuleActive(
  tenantId: number | string,
  moduleKey: string,
  active: boolean,
  actorUserId: number | string
): Promise<void> {
  const moduleId = await tenantModuleId(moduleKey);
  let changed = false;
  if (active) {
    const before = await pool.query(
      `select 1 from tenant_modules tm where tenant_id = $1 and module_id = $2 and ${TENANT_MODULE_ACTIVE_SQL}`,
      [tenantId, moduleId]
    );
    const wasActive = (before.rowCount ?? 0) > 0;
    await pool.query(
      `insert into tenant_modules (tenant_id, module_id, start_date, end_date, cancelled_at)
       values ($1,$2,current_date,null,null)
       on conflict (tenant_id, module_id) do update set
         start_date = current_date, end_date = null, cancelled_at = null`,
      [tenantId, moduleId]
    );
    changed = !wasActive;
  } else {
    const r = await pool.query('delete from tenant_modules where tenant_id = $1 and module_id = $2 returning tenant_id', [
      tenantId,
      moduleId,
    ]);
    changed = (r.rowCount ?? 0) > 0;
  }
  if (changed) {
    await logAuditEvent({
      eventType: 'tenant_subscription_changed',
      userId: actorUserId,
      tenantId,
      role: null,
      detail: { changes: { module: { key: moduleKey, active } } },
    });
  }
}

// Contractuele startdatum van een module-toewijzing wijzigen — vereist een
// bestaande toewijzing (eerst setTenantModuleActive(..., true, ...), zie
// routes/licenses.ts). Een startdatum in de toekomst zet de module tijdelijk
// "nog niet gestart" (zie TENANT_MODULE_ACTIVE_SQL) zonder de toewijzing te
// verwijderen — handig om een module vooraf al in te plannen.
export async function setTenantModuleStartDate(
  tenantId: number | string,
  moduleKey: string,
  startDate: string,
  actorUserId: number | string
): Promise<boolean> {
  const moduleId = await tenantModuleId(moduleKey);
  const before = await pool.query(
    `select to_char(start_date, 'YYYY-MM-DD') as start_date from tenant_modules where tenant_id = $1 and module_id = $2`,
    [tenantId, moduleId]
  );
  if (before.rows.length === 0) return false;
  const beforeStartDate = before.rows[0].start_date as string;
  await pool.query('update tenant_modules set start_date = $1 where tenant_id = $2 and module_id = $3', [
    startDate,
    tenantId,
    moduleId,
  ]);
  if (beforeStartDate !== startDate) {
    await logAuditEvent({
      eventType: 'tenant_subscription_changed',
      userId: actorUserId,
      tenantId,
      role: null,
      detail: { changes: { module: { key: moduleKey, field: 'startDate', from: beforeStartDate, to: startDate } } },
    });
  }
  return true;
}

// Contractuele einddatum van een module-toewijzing wijzigen (null = geen
// einddatum ingesteld) — zelfde polis-semantiek als setTenantLicenseEndDate:
// pas in combinatie met een opzegging (zie setTenantModuleCancelled
// hieronder) maakt een gepasseerde einddatum de module ook echt inactief.
export async function setTenantModuleEndDate(
  tenantId: number | string,
  moduleKey: string,
  endDate: string | null,
  actorUserId: number | string
): Promise<boolean> {
  const moduleId = await tenantModuleId(moduleKey);
  const before = await pool.query(
    `select to_char(end_date, 'YYYY-MM-DD') as end_date from tenant_modules where tenant_id = $1 and module_id = $2`,
    [tenantId, moduleId]
  );
  if (before.rows.length === 0) return false;
  const beforeEndDate = (before.rows[0].end_date as string | null) ?? null;
  await pool.query('update tenant_modules set end_date = $1 where tenant_id = $2 and module_id = $3', [
    endDate,
    tenantId,
    moduleId,
  ]);
  if (beforeEndDate !== endDate) {
    await logAuditEvent({
      eventType: 'tenant_subscription_changed',
      userId: actorUserId,
      tenantId,
      role: null,
      detail: { changes: { module: { key: moduleKey, field: 'endDate', from: beforeEndDate, to: endDate } } },
    });
  }
  return true;
}

// Module-toewijzing opzeggen/opzegging intrekken — los van het abonnement
// zelf (Charles' verzoek: "kunnen ook afzonderlijk worden opgezegd"), zelfde
// polis-model als setSubscriptionCancelled hierboven.
export async function setTenantModuleCancelled(
  tenantId: number | string,
  moduleKey: string,
  cancelled: boolean,
  actorUserId: number | string
): Promise<boolean> {
  const moduleId = await tenantModuleId(moduleKey);
  const before = await pool.query('select cancelled_at from tenant_modules where tenant_id = $1 and module_id = $2', [
    tenantId,
    moduleId,
  ]);
  if (before.rows.length === 0) return false;
  const beforeValue = (before.rows[0].cancelled_at as string | null) ?? null;
  const wasCancelled = beforeValue != null;
  if (wasCancelled === cancelled) return true;
  const newValue = cancelled ? new Date().toISOString() : null;
  await pool.query('update tenant_modules set cancelled_at = $1 where tenant_id = $2 and module_id = $3', [
    newValue,
    tenantId,
    moduleId,
  ]);
  await logAuditEvent({
    eventType: 'tenant_subscription_changed',
    userId: actorUserId,
    tenantId,
    role: null,
    detail: { changes: { module: { key: moduleKey, field: 'cancelledAt', from: beforeValue, to: newValue } } },
  });
  return true;
}

// Gooit LicenseLimitError als het instellen van tierId (null = geen licentie/
// onbeperkt, altijd toegestaan) zou betekenen dat de tenant nu al boven de
// nieuwe limieten zit — zie doelenboom_licentiemodel.md §6 (downgrade vereist
// eerst zelf afbouwen, gebaseerd op ACTIEVE telling, niet cumulatief).
export async function assertTierFits(tenantId: number | string, tierId: number | null): Promise<void> {
  if (tierId == null) return;
  const tierRow = await pool.query(`select ${TIER_SELECT_FIELDS} from tiers where id = $1`, [tierId]);
  const tier = tierRow.rows[0] as Tier | undefined;
  if (!tier) throw new Error('Tier niet gevonden.');
  const [activeEditors, activeBomen] = await Promise.all([countActiveEditors(tenantId), countActiveBomen(tenantId)]);
  const problems: string[] = [];
  if (activeEditors > tier.maxEditors) problems.push(`${activeEditors} actieve admins/editors (max ${tier.maxEditors})`);
  if (activeBomen > tier.maxBomen) problems.push(`${activeBomen} actieve doelenbomen (max ${tier.maxBomen})`);
  if (problems.length) {
    throw new LicenseLimitError(
      `Kan niet naar tier "${tier.name}": eerst afbouwen — ${problems.join(', ')}.`
    );
  }
}

export async function setTenantTier(
  tenantId: number | string,
  tierId: number | null,
  actorUserId: number | string
): Promise<void> {
  await assertTierFits(tenantId, tierId);
  const before = await pool.query('select tier_id from tenants where id = $1', [tenantId]);
  const beforeTierId = before.rows[0]?.tier_id ?? null;
  await pool.query('update tenants set tier_id = $1 where id = $2', [tierId, tenantId]);
  if (beforeTierId !== tierId) {
    await logAuditEvent({
      eventType: 'tenant_subscription_changed',
      userId: actorUserId,
      tenantId,
      role: null,
      detail: { changes: { tier_id: { from: beforeTierId, to: tierId } } },
    });
  }
}

// Gooit LicenseLimitError als er een admin ÓF editor bij komt terwijl de
// tenant geen tier heeft dat nog toelaat — sinds 7 september 2026 tellen
// beide rollen samen tegen tiers.max_editors (zie countActiveEditors
// hierboven en doelenboom_licentiemodel.md §5 v3: "admin telt mee als
// editor"). Alleen relevant bij het TOEVOEGEN van een lidmaatschap dat nog
// niet meetelde (routes/tenants.ts roept dit alleen aan als de gebruiker nog
// geen admin/editor van deze tenant was) — iemands rol wijzigen tussen admin
// en editor (allebei tellen al mee) of een bestaande admin/editor ongewijzigd
// laten mag altijd, ongeacht de limiet (anders zou een tenant die toevallig
// al over de limiet zit — bv. na een downgrade-poging die faalde, of een
// handmatige databasewijziging — muurvast komen te zitten).
export async function assertCanAddEditor(tenantId: number | string): Promise<void> {
  const tenantRow = await pool.query('select tier_id from tenants where id = $1', [tenantId]);
  const tierId = tenantRow.rows[0]?.tier_id as number | null | undefined;
  if (tierId == null) return; // geen tier ingesteld = onbeperkt
  const tier = (await pool.query(`select ${TIER_SELECT_FIELDS} from tiers where id = $1`, [tierId])).rows[0] as
    | Tier
    | undefined;
  if (!tier) return;
  const activeEditors = await countActiveEditors(tenantId);
  if (activeEditors >= tier.maxEditors) {
    throw new LicenseLimitError(
      `Limiet van tier "${tier.name}" bereikt: maximaal ${tier.maxEditors} admin(s)/editor(s) samen. ` +
        'Verwijder eerst een bestaand lid met de rol admin of editor, of vraag een sysadmin om te upgraden.'
    );
  }
}

// Zelfde opzet voor doelenbomen — gebruikt bij zowel het aanmaken van een
// nieuwe doelenboom als het "de-archiveren" van een bestaande (dat verhoogt
// het aantal ACTIEVE bomen net zo goed, zie routes/doelenbomen.ts).
export async function assertCanCreateBoom(tenantId: number | string): Promise<void> {
  const tenantRow = await pool.query('select tier_id from tenants where id = $1', [tenantId]);
  const tierId = tenantRow.rows[0]?.tier_id as number | null | undefined;
  if (tierId == null) return;
  const tier = (await pool.query(`select ${TIER_SELECT_FIELDS} from tiers where id = $1`, [tierId])).rows[0] as
    | Tier
    | undefined;
  if (!tier) return;
  const activeBomen = await countActiveBomen(tenantId);
  if (activeBomen >= tier.maxBomen) {
    throw new LicenseLimitError(
      `Limiet van tier "${tier.name}" bereikt: maximaal ${tier.maxBomen} actieve doelenbomen. ` +
        'Archiveer een bestaande doelenboom of vraag een sysadmin om te upgraden.'
    );
  }
}

// Binnen dezelfde transactie als het aanmaken van een doelenboom (zie
// routes/doelenbomen.ts) — telt alleen op, nooit omlaag (ook niet bij
// archiveren/verwijderen), puur voor rapportage/upsell-signalering, zie
// doelenboom_licentiemodel.md §5.
export async function incrementLifetimeTreesCreated(client: PoolClient, tenantId: number | string): Promise<void> {
  await client.query('update tenants set lifetime_trees_created = lifetime_trees_created + 1 where id = $1', [
    tenantId,
  ]);
}

import { PoolClient } from 'pg';
import { pool } from './db.js';

// Licentiemodel — zie doelenboom_licentiemodel.md en
// doelenboom_licentie_datamodel.drawio in het Doelenboom-project voor het
// volledige ontwerp, en db/migrations/0002_licenses.sql voor de tabellen.
// Bundelt alle databasetoegang tot tiers/modules/tenant_modules en de
// bijbehorende limiet-enforcement, gebruikt door routes/licenses.ts,
// routes/tenants.ts (admin-limiet), routes/doelenbomen.ts (bomen-limiet) en
// rbac.ts (requireModule, voor de "Projecten"-module-gating).

// Prijs staat sinds 30 augustus 2026 NIET meer op de tier zelf — een
// abonnement heeft meerdere prijzen door de tijd heen (bv. € 125/jaar in
// 2026, een ander tarief in 2027), dus dat is een eigen geschiedenis-tabel
// geworden. Zie tierPrices.ts (tier_prices) voor het prijsbeheer, en
// moduleSurcharges.ts (module_surcharges) voor de module-opslagpercentages,
// die om dezelfde reden ook een eigen geschiedenis hebben.
export interface Tier {
  id: number;
  name: string;
  maxAdmins: number;
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
  // ingesteld/nooit verlopen). expired is puur afgeleid (endDate in het
  // verleden), gemakshalve al hier meegegeven zodat de frontend 'm niet zelf
  // hoeft te herleiden.
  endDate: string | null;
  expired: boolean;
  usage: {
    activeAdmins: number;
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
  'id, name, max_admins as "maxAdmins", max_bomen as "maxBomen", sort_order as "sortOrder", ' +
  'trial_days as "trialDays", all_modules_included as "allModulesIncluded"';
const MODULE_SELECT_FIELDS = 'id, key, name, description';

// --- Tiers: door sysadmins vrij te beheren (CRUD), zie routes/licenses.ts. ---

export async function listTiers(): Promise<Tier[]> {
  const r = await pool.query(`select ${TIER_SELECT_FIELDS} from tiers order by sort_order, name`);
  return r.rows;
}

export async function createTier(input: {
  name: string;
  maxAdmins: number;
  maxBomen: number;
  sortOrder: number;
  trialDays?: number | null;
  allModulesIncluded?: boolean;
}): Promise<Tier> {
  const r = await pool.query(
    `insert into tiers (name, max_admins, max_bomen, sort_order, trial_days, all_modules_included)
     values ($1,$2,$3,$4,$5,$6)
     returning ${TIER_SELECT_FIELDS}`,
    [
      input.name,
      input.maxAdmins,
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
    maxAdmins?: number;
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
       max_admins = coalesce($2, max_admins),
       max_bomen = coalesce($3, max_bomen),
       sort_order = coalesce($4, sort_order),
       trial_days = case when $5 then $6 else trial_days end,
       all_modules_included = coalesce($7, all_modules_included),
       updated_at = now()
     where id = $8
     returning ${TIER_SELECT_FIELDS}`,
    [
      input.name ?? null,
      input.maxAdmins ?? null,
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

async function countActiveAdmins(tenantId: number | string): Promise<number> {
  const r = await pool.query(
    `select count(*)::int as n from tenant_users where tenant_id = $1 and role = 'admin'`,
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

export async function getActiveModuleKeys(tenantId: number | string): Promise<string[]> {
  const r = await pool.query(
    `select m.key from tenant_modules tm join modules m on m.id = tm.module_id where tm.tenant_id = $1`,
    [tenantId]
  );
  return r.rows.map((row) => row.key as string);
}

export async function hasModule(tenantId: number | string, moduleKey: string): Promise<boolean> {
  const r = await pool.query(
    `select 1 from tenant_modules tm join modules m on m.id = tm.module_id
     where tm.tenant_id = $1 and m.key = $2`,
    [tenantId, moduleKey]
  );
  return r.rows.length > 0;
}

export async function getTenantLicense(tenantId: number | string): Promise<TenantLicense | null> {
  const tenantRow = await pool.query(
    `select tier_id, lifetime_trees_created,
            to_char(license_end_date, 'YYYY-MM-DD') as end_date,
            (license_end_date is not null and license_end_date < current_date) as expired
     from tenants where id = $1`,
    [tenantId]
  );
  if (tenantRow.rows.length === 0) return null;
  const tierId = tenantRow.rows[0].tier_id as number | null;
  const tier =
    tierId == null
      ? null
      : ((await pool.query(`select ${TIER_SELECT_FIELDS} from tiers where id = $1`, [tierId])).rows[0] ?? null);
  const [activeModules, activeAdmins, activeBomen] = await Promise.all([
    getActiveModuleKeys(tenantId),
    countActiveAdmins(tenantId),
    countActiveBomen(tenantId),
  ]);
  return {
    tier,
    activeModules,
    endDate: tenantRow.rows[0].end_date,
    expired: tenantRow.rows[0].expired,
    usage: {
      activeAdmins,
      activeBomen,
      lifetimeBomenAangemaakt: tenantRow.rows[0].lifetime_trees_created,
    },
  };
}

// Standaard-einddatum bij het aanmaken van een NIEUWE tenant (zie
// routes/tenants.ts POST /): einde van de aanmaakmaand + 12 maanden, dus een
// jaarlicentie die netjes op een maandgrens afloopt. Bijvoorbeeld: aangemaakt
// op 25 augustus 2026 -> einde van augustus 2026 (31 aug) -> +12 maanden ->
// 31 augustus 2027. Werkt op UTC-kalenderdata (los van tijdzone van de
// server) omdat het hier om een kalenderdatum gaat, geen tijdstip.
// Date.UTC(jaar, maand+1, 0) is de laatste dag van "maand" (dag 0 van de
// volgende maand rolt automatisch terug) — hetzelfde trucje voor de
// maand-overflow bij +12 maanden (bv. 29 feb in een schrikkeljaar +12
// maanden rolt netjes door naar 1 maart het jaar erna, er bestaat dan geen
// 29 feb).
export function computeDefaultLicenseEndDate(from: Date): string {
  const endOfCreationMonth = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0));
  const endDate = new Date(
    Date.UTC(endOfCreationMonth.getUTCFullYear() + 1, endOfCreationMonth.getUTCMonth(), endOfCreationMonth.getUTCDate())
  );
  return endDate.toISOString().slice(0, 10);
}

// Zie rbac.ts requireWritableDoelenboom: dezelfde enforcement-plek als de
// bestaande doelenboom.read_only-check, dus zonder apart handhavingspad.
// null (geen einddatum ingesteld) = nooit verlopen, ook de staat waarin elke
// tenant van vóór deze feature terechtkomt (db/migrations/0003_license_expiry.sql).
export async function isLicenseExpired(tenantId: number | string): Promise<boolean> {
  const r = await pool.query(
    `select (license_end_date is not null and license_end_date < current_date) as expired
     from tenants where id = $1`,
    [tenantId]
  );
  return r.rows[0]?.expired ?? false;
}

// Sysadmin-only (zie routes/licenses.ts) — een licentie verlengen/wijzigen,
// of de einddatum wissen (endDate = null, "nooit verlopen"). Geen
// limiet-check nodig hier (in tegenstelling tot setTenantTier): een
// einddatum wijzigen kan een tenant hooguit read-only maken of dat weer
// opheffen, nooit een tier-limiet overschrijden.
export async function setTenantLicenseEndDate(tenantId: number | string, endDate: string | null): Promise<void> {
  await pool.query('update tenants set license_end_date = $1 where id = $2', [endDate, tenantId]);
}

export async function setTenantModuleActive(
  tenantId: number | string,
  moduleKey: string,
  active: boolean
): Promise<void> {
  const moduleRow = await pool.query('select id from modules where key = $1', [moduleKey]);
  if (!moduleRow.rows[0]) throw new Error(`Module "${moduleKey}" bestaat niet.`);
  const moduleId = moduleRow.rows[0].id;
  if (active) {
    await pool.query(
      'insert into tenant_modules (tenant_id, module_id) values ($1,$2) on conflict do nothing',
      [tenantId, moduleId]
    );
  } else {
    await pool.query('delete from tenant_modules where tenant_id = $1 and module_id = $2', [tenantId, moduleId]);
  }
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
  const [activeAdmins, activeBomen] = await Promise.all([countActiveAdmins(tenantId), countActiveBomen(tenantId)]);
  const problems: string[] = [];
  if (activeAdmins > tier.maxAdmins) problems.push(`${activeAdmins} actieve admins (max ${tier.maxAdmins})`);
  if (activeBomen > tier.maxBomen) problems.push(`${activeBomen} actieve doelenbomen (max ${tier.maxBomen})`);
  if (problems.length) {
    throw new LicenseLimitError(
      `Kan niet naar tier "${tier.name}": eerst afbouwen — ${problems.join(', ')}.`
    );
  }
}

export async function setTenantTier(tenantId: number | string, tierId: number | null): Promise<void> {
  await assertTierFits(tenantId, tierId);
  await pool.query('update tenants set tier_id = $1 where id = $2', [tierId, tenantId]);
}

// Gooit LicenseLimitError als er al een admin bij komt terwijl de tenant geen
// tier heeft dat nog toelaat. Alleen relevant bij het TOEVOEGEN van een nieuwe
// admin (routes/tenants.ts roept dit alleen aan als de gebruiker nog geen
// admin van deze tenant was) — een bestaande admin diens rol ongewijzigd
// laten mag altijd, ongeacht de limiet (anders zou een tenant die toevallig
// al over de limiet zit — bv. na een downgrade-poging die faalde, of een
// handmatige databasewijziging — muurvast komen te zitten).
export async function assertCanAddAdmin(tenantId: number | string): Promise<void> {
  const tenantRow = await pool.query('select tier_id from tenants where id = $1', [tenantId]);
  const tierId = tenantRow.rows[0]?.tier_id as number | null | undefined;
  if (tierId == null) return; // geen tier ingesteld = onbeperkt
  const tier = (await pool.query(`select ${TIER_SELECT_FIELDS} from tiers where id = $1`, [tierId])).rows[0] as
    | Tier
    | undefined;
  if (!tier) return;
  const activeAdmins = await countActiveAdmins(tenantId);
  if (activeAdmins >= tier.maxAdmins) {
    throw new LicenseLimitError(
      `Limiet van tier "${tier.name}" bereikt: maximaal ${tier.maxAdmins} admin(s). ` +
        'Verwijder eerst een bestaande admin of vraag een sysadmin om te upgraden.'
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

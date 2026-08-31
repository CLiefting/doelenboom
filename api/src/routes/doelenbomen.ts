import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, AuthedRequest } from '../auth.js';
import {
  requireSysadmin,
  requireTenantRole,
  requireTenantRoleForDoelenboomParam,
  requireTenantRoleForTenantParam,
  tenantIdForDoelenboom,
} from '../rbac.js';
import { createDoelenboomConfigFromTenantDefault, copyDoelenboomConfig } from '../columnConfig.js';
import { seedExampleTree } from '../exampleTree.js';
import { applyTemplateToNewDoelenboom } from '../doelenboomTemplates.js';
import { assertCanCreateBoom, incrementLifetimeTreesCreated, isLicenseExpired, LicenseLimitError } from '../license.js';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

// Let op: dit router wordt gemount op '/api' (niet '/api/doelenbomen'), zodat zowel
// '/api/doelenbomen' als '/api/tenants/:tenantId/doelenbomen' vanuit één bestand
// gedefinieerd kunnen worden zonder rare dubbele nesting in de URL's.
export const doelenbomenRouter = Router();
doelenbomenRouter.use(requireAuth);

// Alle doelenbomen die deze gebruiker mag zien — sysadmin ziet alles, anders
// alleen doelenbomen van tenants waar hij/zij lid van is (rol maakt niet uit,
// gebruiker mag ook lezen) ÓF van een tenant met open toegang (tenants.
// open_access_role, zie rbac.ts getTenantRole) — ook zonder eigen
// tenant_users-rij. Zonder de tenant-filter zag elke ingelogde gebruiker
// vroeger alle tenants door elkaar in de picker.
// archived_at (als "archivedAt"): zie license.ts — een gearchiveerde
// doelenboom telt niet mee als "actieve" boom voor de tier-limiet (§5,
// doelenboom_licentiemodel.md), maar blijft verder gewoon bestaan/leesbaar.
const DOELENBOOM_FIELDS =
  'd.id, d.slug, d.name, d.read_only, d.wipe_on_empty, d.stale_after_days as "staleAfterDays", ' +
  'd.archived_at as "archivedAt", d.created_at';

doelenbomenRouter.get('/doelenbomen', async (req: AuthedRequest, res) => {
  if (req.user!.isSysadmin) {
    const result = await pool.query(
      `select ${DOELENBOOM_FIELDS}, t.id as tenant_id, t.slug as tenant_slug, t.name as tenant_name
       from doelenbomen d
       join tenants t on t.id = d.tenant_id
       order by t.name, d.name`
    );
    return res.json(result.rows);
  }
  const result = await pool.query(
    `select ${DOELENBOOM_FIELDS}, t.id as tenant_id, t.slug as tenant_slug, t.name as tenant_name
     from doelenbomen d
     join tenants t on t.id = d.tenant_id
     where t.open_access_role is not null
        or exists (select 1 from tenant_users tu where tu.tenant_id = t.id and tu.user_id = $1)
     order by t.name, d.name`,
    [req.user!.id]
  );
  res.json(result.rows);
});

doelenbomenRouter.get(
  '/doelenbomen/:id',
  requireTenantRole('bezoeker', (req) => tenantIdForDoelenboom(req.params.id)),
  async (req, res) => {
    const result = await pool.query(
      `select ${DOELENBOOM_FIELDS}, t.id as tenant_id, t.slug as tenant_slug, t.name as tenant_name
       from doelenbomen d join tenants t on t.id = d.tenant_id
       where d.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Niet gevonden' });
    res.json(result.rows[0]);
  }
);

doelenbomenRouter.get(
  '/tenants/:tenantId/doelenbomen',
  requireTenantRoleForTenantParam('bezoeker', 'tenantId'),
  async (req, res) => {
    const result = await pool.query(
      'select id, slug, name, read_only, wipe_on_empty, stale_after_days as "staleAfterDays", ' +
        'archived_at as "archivedAt", created_at ' +
        'from doelenbomen where tenant_id = $1 order by name',
      [req.params.tenantId]
    );
    res.json(result.rows);
  }
);

// Een nieuwe doelenboom binnen een tenant aanmaken is een tenant-wijziging —
// toegestaan voor sysadmins en tenant-admins van die tenant, niet voor gewone
// gebruikers. wipe_on_empty wordt geseed vanuit tenants.wipe_on_empty (de
// "standaardinstelling" van de tenant, zie db/init.sql) zodat je 'm niet elke
// keer opnieuw hoeft te zetten — na aanmaken is 't gewoon een eigen,
// onafhankelijk instelbare vlag op déze doelenboom.
//
// templateId (optioneel, zie api/src/doelenboomTemplates.ts): welk sjabloon
// (kolommen + voorbeeldelementen + relaties) de nieuwe doelenboom meekrijgt.
// De frontend stuurt 'm altijd mee (default "Batenboom"), maar hij is hier
// bewust optioneel gebleven — zonder templateId valt dit terug op het oude
// gedrag (tenant-default kolommen + de generieke 1-per-kolom-seeding), zodat
// bestaande API-aanroepen die 'm niet meesturen niet stuklopen.
doelenbomenRouter.post(
  '/tenants/:tenantId/doelenbomen',
  requireTenantRoleForTenantParam('admin', 'tenantId'),
  async (req, res) => {
    const { slug, name, templateId } = req.body ?? {};
    if (!slug || !name) {
      return res.status(400).json({ error: 'slug en name zijn verplicht' });
    }
    // Verlopen licentie (zie license.ts isLicenseExpired,
    // doelenboom_licentiemodel.md §6/§9) blokkeert ook het aanmaken van een
    // NIEUWE doelenboom — zonder deze check zou requireWritableDoelenboom's
    // read_only/verlopen-check (die alleen op BESTAANDE doelenbomen werkt)
    // omzeild kunnen worden door simpelweg een nieuwe boom aan te maken.
    if (await isLicenseExpired(req.params.tenantId)) {
      return res.status(403).json({
        error: 'De licentie van deze tenant is verlopen; neem contact op om te verlengen.',
      });
    }
    // Vóór de transactie: telt tegen de tier-limiet (actieve bomen, zie
    // license.ts) — geen tier ingesteld = onbeperkt, dan is dit een no-op.
    try {
      await assertCanCreateBoom(req.params.tenantId);
    } catch (err) {
      if (err instanceof LicenseLimitError) return res.status(403).json({ error: err.message });
      throw err;
    }
    const client = await pool.connect();
    try {
      await client.query('begin');
      const tenantRow = await client.query('select wipe_on_empty, name from tenants where id = $1', [req.params.tenantId]);
      const defaultWipeOnEmpty = tenantRow.rows[0]?.wipe_on_empty ?? false;
      const result = await client.query(
        `insert into doelenbomen (tenant_id, slug, name, wipe_on_empty)
         values ($1, $2, $3, $4)
         returning id, slug, name, read_only, wipe_on_empty, stale_after_days as "staleAfterDays",
           archived_at as "archivedAt", created_at`,
        [req.params.tenantId, slug, name, defaultWipeOnEmpty]
      );
      if (templateId != null) {
        // Sjabloon toepassen: kolommen + voorbeeldelementen + relaties komen
        // uit de snapshot (zie doelenboomTemplates.ts). Bestaat het sjabloon
        // niet (meer) of is het niet zichtbaar voor deze tenant, dan rollen
        // we de hele aanmaak terug — beter een duidelijke foutmelding dan een
        // doelenboom zonder kolommen.
        const applied = await applyTemplateToNewDoelenboom(
          client,
          Number(templateId),
          Number(req.params.tenantId),
          result.rows[0].id
        );
        if (!applied) {
          await client.query('rollback');
          return res.status(400).json({ error: 'Sjabloon niet gevonden of niet beschikbaar voor deze tenant.' });
        }
      } else {
        // Geen sjabloon meegestuurd: oud gedrag — eigen, onafhankelijke
        // kopie van de tenant-default kolomconfiguratie (zie columnConfig.ts)
        // + de generieke 1-per-kolom-voorbeeldboom (zie exampleTree.ts).
        await createDoelenboomConfigFromTenantDefault(
          client,
          Number(req.params.tenantId),
          tenantRow.rows[0]?.name ?? '',
          result.rows[0].id
        );
        await seedExampleTree(client, result.rows[0].id);
      }
      // Telt alleen op, nooit omlaag — zie license.ts incrementLifetimeTreesCreated.
      await incrementLifetimeTreesCreated(client, req.params.tenantId);
      await client.query('commit');
      res.status(201).json(result.rows[0]);
    } catch (err) {
      await client.query('rollback');
      res.status(409).json({ error: 'Doelenboom met deze slug bestaat al binnen deze tenant', detail: (err as Error).message });
    } finally {
      client.release();
    }
  }
);

// PUT /api/doelenbomen/:id — { name?, slug?, readOnly?, wipeOnEmpty?, archived? }.
// Dit zijn instellingen van de doelenboom zelf (naam/slug/alleen-lezen/
// auto-leegmaken/gearchiveerd), geen "boom-inhoud" — daarom hier bewust
// requireTenantRoleForDoelenboomParam i.p.v. requireWritableDoelenboom: een
// tenant-admin mag de read-only-vlag altijd zelf weer uitzetten, ook als de
// doelenboom op dit moment read-only staat (anders zou een tenant-admin
// zichzelf kunnen buitensluiten zonder sysadmin erbij te hoeven halen).
// "archived" (zie license.ts/doelenboom_licentiemodel.md §5): een
// gearchiveerde doelenboom telt niet mee als "actief" voor de tier-limiet.
// De-archiveren verhoogt het aantal actieve bomen weer met één, dus dat gaat
// via dezelfde limiet-check als het aanmaken van een nieuwe boom
// (assertCanCreateBoom telt deze boom, terwijl 'ie nog archived_at != null
// heeft, niet mee — dus "activeBomen >= max" klopt precies voor de situatie
// ná de-archivering).
doelenbomenRouter.put(
  '/doelenbomen/:id',
  // allowSysadmin: true — dit zijn doelenboom-"instellingen"/toegangsbeheer,
  // geen boom-inhoud (zie rbac.ts rolmodel-comment en de gematigde
  // sysadmin-scope hierboven bij deze route).
  requireTenantRoleForDoelenboomParam('admin', 'id', { allowSysadmin: true }),
  async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const slug = typeof b.slug === 'string' ? b.slug.trim() : '';
    const readOnly = typeof b.readOnly === 'boolean' ? b.readOnly : undefined;
    const wipeOnEmpty = typeof b.wipeOnEmpty === 'boolean' ? b.wipeOnEmpty : undefined;
    const archived = typeof b.archived === 'boolean' ? b.archived : undefined;
    // staleAfterDays: drempel (in dagen) voor de 'verouderd'-markering op
    // projectelementen — zie db/migrations/0020_project_status_review.sql.
    // Zelfde check-constraint-grenzen als de database (1-3650), hier al
    // gevalideerd voor een nette foutmelding i.p.v. een rauwe database-error.
    const staleAfterDaysRaw = b.staleAfterDays;
    const staleAfterDays =
      typeof staleAfterDaysRaw === 'number' && Number.isInteger(staleAfterDaysRaw) ? staleAfterDaysRaw : undefined;
    if (staleAfterDaysRaw !== undefined && staleAfterDays === undefined) {
      return res.status(400).json({ error: 'staleAfterDays moet een geheel getal zijn.' });
    }
    if (staleAfterDays !== undefined && (staleAfterDays < 1 || staleAfterDays > 3650)) {
      return res.status(400).json({ error: 'staleAfterDays moet tussen 1 en 3650 liggen.' });
    }
    if (!name) return res.status(400).json({ error: 'Naam is verplicht.' });

    const current = await pool.query(
      'select tenant_id, slug, read_only, wipe_on_empty, stale_after_days, archived_at from doelenbomen where id = $1',
      [req.params.id]
    );
    if (current.rows.length === 0) return res.status(404).json({ error: 'Doelenboom niet gevonden.' });
    const newSlug = slug || current.rows[0].slug;
    const newReadOnly = readOnly === undefined ? current.rows[0].read_only : readOnly;
    const newWipeOnEmpty = wipeOnEmpty === undefined ? current.rows[0].wipe_on_empty : wipeOnEmpty;
    const newStaleAfterDays = staleAfterDays === undefined ? current.rows[0].stale_after_days : staleAfterDays;
    const wasArchived = current.rows[0].archived_at != null;
    const willBeArchived = archived === undefined ? wasArchived : archived;

    if (!wasArchived && willBeArchived === false) {
      // geen wijziging, geen limiet-check nodig
    } else if (wasArchived && !willBeArchived) {
      // De-archiveren: telt weer mee als actieve boom, dus tegen de tier-limiet aan.
      try {
        await assertCanCreateBoom(current.rows[0].tenant_id);
      } catch (err) {
        if (err instanceof LicenseLimitError) return res.status(403).json({ error: err.message });
        throw err;
      }
    }

    try {
      const result = await pool.query(
        `update doelenbomen set name = $1, slug = $2, read_only = $3, wipe_on_empty = $4, stale_after_days = $5,
           archived_at = case when $6 then coalesce(archived_at, now()) else null end
         where id = $7
         returning id, slug, name, read_only, wipe_on_empty, stale_after_days as "staleAfterDays",
           archived_at as "archivedAt", created_at`,
        [name, newSlug, newReadOnly, newWipeOnEmpty, newStaleAfterDays, willBeArchived, req.params.id]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(409).json({ error: 'Doelenboom met deze slug bestaat al binnen deze tenant', detail: (err as Error).message });
    }
  }
);

// DELETE /api/doelenbomen/:id — cascade (db/init.sql) ruimt elementen/relaties/
// tags/organisatieonderdelen/imports van deze doelenboom automatisch mee op.
// Zelfde toegang als hernoemen/read-only (tenant-beheer, niet "boom-inhoud").
doelenbomenRouter.delete(
  '/doelenbomen/:id',
  // allowSysadmin: true — dit zijn doelenboom-"instellingen"/toegangsbeheer,
  // geen boom-inhoud (zie rbac.ts rolmodel-comment en de gematigde
  // sysadmin-scope hierboven bij deze route).
  requireTenantRoleForDoelenboomParam('admin', 'id', { allowSysadmin: true }),
  async (req, res) => {
    const result = await pool.query('delete from doelenbomen where id = $1 returning id', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Doelenboom niet gevonden.' });
    res.status(204).send();
  }
);

// GET /api/doelenbomen/:id/member-roles — alle leden van de tenant van deze
// doelenboom, met hun tenant-rol, een eventuele override specifiek voor déze
// doelenboom, en de daaruit volgende effectieve rol. Zelfde toegang als
// hernoemen/read-only (tenant-/doelenboom-admin, geen sysadmin-only) — een
// tenant-admin moet dit voor zijn eigen tenant kunnen beheren.
doelenbomenRouter.get(
  '/doelenbomen/:id/member-roles',
  // allowSysadmin: true — dit zijn doelenboom-"instellingen"/toegangsbeheer,
  // geen boom-inhoud (zie rbac.ts rolmodel-comment en de gematigde
  // sysadmin-scope hierboven bij deze route).
  requireTenantRoleForDoelenboomParam('admin', 'id', { allowSysadmin: true }),
  async (req, res) => {
    const result = await pool.query(
      `select u.id as user_id, u.email, tu.role as tenant_role, dur.role as override_role
       from tenant_users tu
       join users u on u.id = tu.user_id
       left join doelenboom_user_roles dur on dur.doelenboom_id = $1 and dur.user_id = u.id
       where tu.tenant_id = (select tenant_id from doelenbomen where id = $1)
       order by u.email`,
      [req.params.id]
    );
    res.json(
      result.rows.map((r) => ({
        userId: r.user_id,
        email: r.email,
        tenantRole: r.tenant_role,
        overrideRole: r.override_role,
        effectiveRole: r.override_role ?? r.tenant_role,
      }))
    );
  }
);

// PUT /api/doelenbomen/:id/member-roles/:userId — { role: 'admin' | 'gebruiker' | 'bezoeker' | null }.
// null verwijdert de override (terug naar de tenant-rol). De gebruiker moet
// wél lid zijn van de tenant van deze doelenboom — een override kan geen
// toegang geven aan iemand die geen tenant-lid is, alleen de rol bijstellen
// binnen een doelenboom die diegene al mag zien.
doelenbomenRouter.put(
  '/doelenbomen/:id/member-roles/:userId',
  // allowSysadmin: true — dit zijn doelenboom-"instellingen"/toegangsbeheer,
  // geen boom-inhoud (zie rbac.ts rolmodel-comment en de gematigde
  // sysadmin-scope hierboven bij deze route).
  requireTenantRoleForDoelenboomParam('admin', 'id', { allowSysadmin: true }),
  async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const role =
      b.role === 'admin' || b.role === 'gebruiker' || b.role === 'bezoeker' ? b.role : b.role === null ? null : undefined;
    if (role === undefined) {
      return res.status(400).json({ error: 'role moet "admin", "gebruiker", "bezoeker" of null zijn.' });
    }

    const member = await pool.query(
      `select 1 from tenant_users tu
       where tu.user_id = $1 and tu.tenant_id = (select tenant_id from doelenbomen where id = $2)`,
      [req.params.userId, req.params.id]
    );
    if (member.rows.length === 0) {
      return res.status(404).json({ error: 'Deze gebruiker is geen lid van de tenant van deze doelenboom.' });
    }

    if (role === null) {
      await pool.query(
        'delete from doelenboom_user_roles where doelenboom_id = $1 and user_id = $2',
        [req.params.id, req.params.userId]
      );
    } else {
      await pool.query(
        `insert into doelenboom_user_roles (doelenboom_id, user_id, role) values ($1, $2, $3)
         on conflict (doelenboom_id, user_id) do update set role = excluded.role`,
        [req.params.id, req.params.userId, role]
      );
    }
    res.status(204).send();
  }
);

// POST /api/doelenbomen/:id/duplicate — { slug, name, targetTenantId?, newTenant?: { slug, name } }
// Sysadmin-only: dupliceert een doelenboom inclusief alle inhoud (elementen,
// relaties, projectstatus, producten, tags + koppelingen, organisatieonderdelen
// + koppelingen) naar een nieuwe doelenboom — desgewenst in dezelfde tenant, een
// andere bestaande tenant (targetTenantId), of een gloednieuwe tenant (newTenant,
// in dezelfde transactie aangemaakt zodat er bij een mislukte kopie geen lege
// tenant achterblijft). Imports (excel_imports) worden bewust NIET meegekopieerd
// — dat is upload-historie/audit-trail, geen boom-inhoud. De duplicaat start
// altijd met read_only=false en wipe_on_empty=false, ongeacht de bron — dat zijn
// per-boom operationele vlaggen die je na het dupliceren zelf weer instelt.
doelenbomenRouter.post('/doelenbomen/:id/duplicate', requireSysadmin, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const slug = typeof b.slug === 'string' ? b.slug.trim() : '';
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const targetTenantId = typeof b.targetTenantId === 'number' ? b.targetTenantId : undefined;
  const newTenantInput = (b.newTenant ?? null) as { slug?: unknown; name?: unknown } | null;
  const newTenantSlug = typeof newTenantInput?.slug === 'string' ? newTenantInput.slug.trim() : '';
  const newTenantName = typeof newTenantInput?.name === 'string' ? newTenantInput.name.trim() : '';

  if (!slug || !name) return res.status(400).json({ error: 'slug en name zijn verplicht.' });
  if (newTenantInput && (!newTenantSlug || !newTenantName)) {
    return res.status(400).json({ error: 'newTenant.slug en newTenant.name zijn verplicht.' });
  }

  const client = await pool.connect();
  try {
    await client.query('begin');

    const source = await client.query('select tenant_id, stale_after_days from doelenbomen where id = $1', [req.params.id]);
    if (source.rows.length === 0) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Bron-doelenboom niet gevonden.' });
    }

    let resolvedTenantId: number = targetTenantId ?? source.rows[0].tenant_id;
    if (newTenantInput) {
      const tenantResult = await client.query(
        'insert into tenants (slug, name) values ($1, $2) returning id',
        [newTenantSlug, newTenantName]
      );
      resolvedTenantId = tenantResult.rows[0].id;
    }

    const newDoelenboom = await client.query(
      `insert into doelenbomen (tenant_id, slug, name, stale_after_days)
       values ($1, $2, $3, $4)
       returning id, slug, name, read_only, wipe_on_empty, stale_after_days as "staleAfterDays",
         archived_at as "archivedAt", created_at`,
      [resolvedTenantId, slug, name, source.rows[0].stale_after_days]
    );
    const newDoelenboomId = newDoelenboom.rows[0].id;
    // Sysadmin-only route (zie de rbac-check hierboven) — bewust géén
    // tier-limiet-check hier, consistent met de rest van deze codebase waar
    // een sysadmin altijd door mag; het is aan de sysadmin zelf om nadien de
    // tier van de doeltenant bij te stellen indien nodig. Wél de
    // lifetime-teller bijwerken, want dat is puur rapportage/upsell-
    // signalering (zie license.ts), geen enforcement.
    await incrementLifetimeTreesCreated(client, resolvedTenantId);

    // Eigen kopie van de kolomconfiguratie van de bron-doelenboom (niet de
    // tenant-default — de bron kan zelf al een aangepaste config hebben, en
    // de elementen hieronder worden zo dadelijk met dezelfde typenamen
    // gekopieerd, dus moeten wel bij een bestaande kolom passen).
    await copyDoelenboomConfig(client, Number(req.params.id), resolvedTenantId, newDoelenboomId);

    const elementsResult = await client.query(
      `select id, code, type, name, description, parent_text, kpi, taakveld, subtaakveld, sort_order
       from elements where doelenboom_id = $1`,
      [req.params.id]
    );
    const sourceElementIds = elementsResult.rows.map((r) => r.id);
    const elementIdMap = new Map<number, number>();
    for (const el of elementsResult.rows) {
      const r = await client.query(
        `insert into elements
           (doelenboom_id, code, type, name, description, parent_text, kpi, taakveld, subtaakveld, sort_order)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [
          newDoelenboomId, el.code, el.type, el.name, el.description,
          el.parent_text, el.kpi, el.taakveld, el.subtaakveld, el.sort_order,
        ]
      );
      elementIdMap.set(el.id, r.rows[0].id);
    }

    const edgesResult = await client.query(
      'select source_element_id, target_element_id, weight, toelichting from edges where doelenboom_id = $1',
      [req.params.id]
    );
    for (const e of edgesResult.rows) {
      const newSource = elementIdMap.get(e.source_element_id);
      const newTarget = elementIdMap.get(e.target_element_id);
      if (!newSource || !newTarget) continue;
      await client.query(
        `insert into edges (doelenboom_id, source_element_id, target_element_id, weight, toelichting)
         values ($1,$2,$3,$4,$5)`,
        [newDoelenboomId, newSource, newTarget, e.weight, e.toelichting]
      );
    }

    const psResult = await client.query(
      `select element_id, projectstatus, rag, toelichting, gerapporteerd_op, cluster_ppt, updated_at, updated_by
       from project_status where element_id = any($1::bigint[])`,
      [sourceElementIds]
    );
    for (const ps of psResult.rows) {
      const newElementId = elementIdMap.get(ps.element_id);
      if (!newElementId) continue;
      await client.query(
        `insert into project_status (element_id, projectstatus, rag, toelichting, gerapporteerd_op, cluster_ppt, updated_at, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [newElementId, ps.projectstatus, ps.rag, ps.toelichting, ps.gerapporteerd_op, ps.cluster_ppt, ps.updated_at, ps.updated_by]
      );
    }

    const productsResult = await client.query(
      `select element_id, code, name, type, omschrijving, pct_gereed, verwachte_datum, werkelijke_datum, opmerking
       from products where element_id = any($1::bigint[])`,
      [sourceElementIds]
    );
    for (const p of productsResult.rows) {
      const newElementId = elementIdMap.get(p.element_id);
      if (!newElementId) continue;
      await client.query(
        `insert into products
           (element_id, code, name, type, omschrijving, pct_gereed, verwachte_datum, werkelijke_datum, opmerking)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [newElementId, p.code, p.name, p.type, p.omschrijving, p.pct_gereed, p.verwachte_datum, p.werkelijke_datum, p.opmerking]
      );
    }

    const tagsResult = await client.query(
      'select id, code, name, categorie, omschrijving from tags where doelenboom_id = $1',
      [req.params.id]
    );
    const tagIdMap = new Map<number, number>();
    for (const t of tagsResult.rows) {
      const r = await client.query(
        'insert into tags (doelenboom_id, code, name, categorie, omschrijving) values ($1,$2,$3,$4,$5) returning id',
        [newDoelenboomId, t.code, t.name, t.categorie, t.omschrijving]
      );
      tagIdMap.set(t.id, r.rows[0].id);
    }

    const elementTagsResult = await client.query(
      'select element_id, tag_id, toelichting from element_tags where element_id = any($1::bigint[])',
      [sourceElementIds]
    );
    for (const et of elementTagsResult.rows) {
      const newElementId = elementIdMap.get(et.element_id);
      const newTagId = tagIdMap.get(et.tag_id);
      if (!newElementId || !newTagId) continue;
      await client.query(
        'insert into element_tags (element_id, tag_id, toelichting) values ($1,$2,$3)',
        [newElementId, newTagId, et.toelichting]
      );
    }

    const orgUnitsResult = await client.query(
      'select id, code, name, omschrijving from org_units where doelenboom_id = $1',
      [req.params.id]
    );
    const orgUnitIdMap = new Map<number, number>();
    for (const o of orgUnitsResult.rows) {
      const r = await client.query(
        'insert into org_units (doelenboom_id, code, name, omschrijving) values ($1,$2,$3,$4) returning id',
        [newDoelenboomId, o.code, o.name, o.omschrijving]
      );
      orgUnitIdMap.set(o.id, r.rows[0].id);
    }

    const obOrgResult = await client.query(
      `select element_id, org_unit_id, relatietype, toelichting, status
       from ob_org_relations where element_id = any($1::bigint[])`,
      [sourceElementIds]
    );
    for (const rel of obOrgResult.rows) {
      const newElementId = elementIdMap.get(rel.element_id);
      const newOrgUnitId = orgUnitIdMap.get(rel.org_unit_id);
      if (!newElementId || !newOrgUnitId) continue;
      await client.query(
        `insert into ob_org_relations (element_id, org_unit_id, relatietype, toelichting, status)
         values ($1,$2,$3,$4,$5)`,
        [newElementId, newOrgUnitId, rel.relatietype, rel.toelichting, rel.status]
      );
    }

    await client.query('commit');

    const tenantInfo = await pool.query('select id, slug, name from tenants where id = $1', [resolvedTenantId]);
    res.status(201).json({
      ...newDoelenboom.rows[0],
      tenant_id: tenantInfo.rows[0].id,
      tenant_slug: tenantInfo.rows[0].slug,
      tenant_name: tenantInfo.rows[0].name,
    });
  } catch (err) {
    await client.query('rollback');
    if (isUniqueViolation(err)) {
      return res
        .status(409)
        .json({ error: 'Doelenboom- of tenant-slug bestaat al.', detail: (err as Error).message });
    }
    res.status(500).json({ error: 'Dupliceren mislukt', detail: (err as Error).message });
  } finally {
    client.release();
  }
});

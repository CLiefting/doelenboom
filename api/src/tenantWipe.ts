import { pool } from './db.js';

// "Tenant leegmaken bij vertrek laatste gebruiker" — zie db/init.sql (sessions,
// tenants.wipe_on_empty/session_timeout_minutes) en de toelichting in README.md
// onder "Sessies & automatisch leegmaken".
//
// Toegangsmodel (v2, sinds het rolmodel in db/init.sql): "iemand heeft toegang
// tot tenant X" betekent nu echt "is sysadmin, óf heeft een rij in tenant_users
// voor tenant X" (rol admin of gebruiker maakt hier niet uit — beide tellen als
// actieve toegang; alleen schrijfrechten verschillen, zie rbac.ts).

export type WipeCandidate = {
  tenant: { id: number; slug: string; name: string };
  // elementCount: hiermee kan de frontend bij uitloggen de exportvraag
  // overslaan als een doelenboom toch al leeg is (niets te exporteren/verliezen).
  doelenbomen: Array<{ id: number; slug: string; name: string; elementCount: number }>;
};

// Is er op dit moment nog een sessie die toegang heeft tot deze tenant, gezien
// zijn eigen session_timeout_minutes? Een sessie telt mee als: niet expliciet
// beëindigd (ended_at is null), recent genoeg gezien (last_seen_at binnen de
// timeout van déze tenant — vandaar per tenant een andere uitkomst mogelijk is),
// en van een gebruiker met toegang. excludeSessionId sluit de sessie uit die net
// aan het uitloggen is (die is op dat moment nog niet als ended_at gemarkeerd,
// of we willen 'm sowieso negeren tijdens de preview).
async function tenantHasActiveAccess(
  tenantId: number,
  timeoutMinutes: number,
  excludeSessionId?: string
): Promise<boolean> {
  const result = await pool.query(
    `select 1
     from sessions s
     join users u on u.id = s.user_id
     where s.ended_at is null
       and (
         u.is_sysadmin = true
         or exists (select 1 from tenant_users tu where tu.user_id = u.id and tu.tenant_id = $3)
       )
       and s.last_seen_at > now() - make_interval(mins => $1::int)
       and ($2::uuid is null or s.id != $2)
     limit 1`,
    [timeoutMinutes, excludeSessionId ?? null, tenantId]
  );
  return (result.rowCount ?? 0) > 0;
}

async function wipeDoelenboomData(doelenboomId: number): Promise<void> {
  // Zelfde volgorde/aanpak als de "volledige vervanging" bij het publiceren van
  // een import (routes/imports.ts): elements cascadet naar edges/project_status/
  // products/element_tags/ob_org_relations. Doelenboom-rij zelf blijft bestaan.
  await pool.query('delete from elements where doelenboom_id = $1', [doelenboomId]);
  await pool.query('delete from tags where doelenboom_id = $1', [doelenboomId]);
  await pool.query('delete from org_units where doelenboom_id = $1', [doelenboomId]);
  await pool.query('delete from excel_imports where doelenboom_id = $1', [doelenboomId]);
}

// Bepaalt welke doelenbomen (gegroepeerd per tenant) op dit moment "verlaten"
// zijn — de doelenboom heeft wipe_on_empty aan staan (per-doelenboom instelbaar
// sinds een tenant meerdere doelenbomen kan hebben, zie db/init.sql) én er is
// geen actieve sessie meer met toegang tot de tenant van die doelenboom (de
// timing zelf, session_timeout_minutes, blijft wél tenant-breed — een sessie
// heeft nu eenmaal toegang tot een hele tenant, niet tot één specifieke boom).
// Andere doelenbomen in dezelfde tenant zonder wipe_on_empty blijven met rust,
// ook als de tenant verder helemaal verlaten is.
//
// Als commit=true wordt de data ook daadwerkelijk geleegd (en, indien sessionId
// gegeven, die sessie eerst als beëindigd gemarkeerd). Met commit=false is dit
// een pure preview (voor de "wil je exporteren?"-vraag bij uitloggen), zonder
// bijeffecten.
//
// requestingUser: bij een expliciete logout (vanuit routes/auth.ts) alleen
// tenants tonen waar déze gebruiker ook echt lid van is (of alle tenants als
// die sysadmin is) — anders kreeg een gebruiker zonder enige toegang tot bv.
// tenant KMar bij het uitloggen tóch een wipe-melding voor KMar te zien, puur
// omdat toevallig niemand anders op dat moment nog een actieve KMar-sessie
// had. Bij de periodieke idle-sweep (sweepIdleTenants) is er geen specifieke
// gebruiker die uitlogt, dus blijft dit param leeg en gelden alle
// wipe_on_empty-doelenbomen zoals voorheen.
export async function previewOrCommitWipe(
  sessionId: string | null,
  commit: boolean,
  requestingUser?: { id: number; isSysadmin: boolean }
): Promise<WipeCandidate[]> {
  if (commit && sessionId) {
    await pool.query('update sessions set ended_at = now() where id = $1 and ended_at is null', [sessionId]);
  }

  // distinct: een tenant met meerdere wipe_on_empty-doelenbomen mag hier maar
  // één keer in staan — welke doelenbomen precies gewipet worden, bepaalt de
  // query verderop (opnieuw gefilterd op wipe_on_empty).
  const tenantsResult =
    requestingUser && !requestingUser.isSysadmin
      ? await pool.query(
          `select distinct t.id, t.slug, t.name, t.session_timeout_minutes
           from tenants t
           join doelenbomen d on d.tenant_id = t.id and d.wipe_on_empty = true
           join tenant_users tu on tu.tenant_id = t.id
           where tu.user_id = $1`,
          [requestingUser.id]
        )
      : await pool.query(
          `select distinct t.id, t.slug, t.name, t.session_timeout_minutes
           from tenants t
           join doelenbomen d on d.tenant_id = t.id and d.wipe_on_empty = true`
        );

  const candidates: WipeCandidate[] = [];
  for (const t of tenantsResult.rows) {
    // Bij commit is de uitloggende sessie al ended_at=now(), dus excludeSessionId
    // is dan niet meer nodig; bij een preview (nog niet gecommit) sluiten we 'm
    // wél expliciet uit, zodat de preview alvast toont wat er zou gebeuren.
    const stillActive = await tenantHasActiveAccess(
      t.id,
      t.session_timeout_minutes,
      commit ? undefined : sessionId ?? undefined
    );
    if (stillActive) continue;

    const doelenbomenResult = await pool.query(
      `select d.id, d.slug, d.name, count(e.id)::int as "elementCount"
       from doelenbomen d
       left join elements e on e.doelenboom_id = d.id
       where d.tenant_id = $1 and d.wipe_on_empty = true
       group by d.id, d.slug, d.name
       order by d.name`,
      [t.id]
    );
    if (doelenbomenResult.rows.length === 0) continue;

    candidates.push({
      tenant: { id: t.id, slug: t.slug, name: t.name },
      doelenbomen: doelenbomenResult.rows,
    });
  }

  if (commit) {
    for (const c of candidates) {
      for (const d of c.doelenbomen) {
        await wipeDoelenboomData(d.id);
      }
    }
  }

  return candidates;
}

// Periodieke sweep (elke minuut vanuit index.ts) — vangt browsers die zonder
// uitloggen gesloten zijn: geen enkele sessie hoeft hiervoor expliciet beëindigd
// te worden, tenantHasActiveAccess kijkt toch al naar last_seen_at t.o.v. de
// (per-tenant instelbare) timeout. Let op: hier is niemand meer om een
// Excel-export aan te bieden — dat kan alleen bij een expliciete logout
// (zie routes/auth.ts: GET /api/auth/logout-preview).
export async function sweepIdleTenants(): Promise<WipeCandidate[]> {
  return previewOrCommitWipe(null, true);
}

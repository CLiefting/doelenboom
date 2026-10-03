import { Router } from 'express';
import { pool } from '../db.js';
import { AuthedRequest, requireAuth } from '../auth.js';
import {
  requireModule,
  requireSysadmin,
  requireTenantRoleForDoelenboomParam,
  requireWritableDoelenboom,
  tenantIdForDoelenboom,
} from '../rbac.js';
import { allValidTypeNames, getColumnsForDoelenboom, getTenantDefaultColumns } from '../columnConfig.js';
import {
  applyElementValueChanges,
  countValuesPerAttribute,
  deleteValuesForChangedDefinitions,
  getAttributeValues,
  validateElementValuesInput,
} from '../elementAttributeValues.js';
import { CONTROLE_REGELS_MODULE } from '../controlRules.js';
import {
  AttributeDef,
  attributesFromDb,
  findAttributesBrokenByColumns,
  getTenantDefaultAttributes,
  setAttributesForConfigId,
  validateAttributeDefsInput,
} from '../elementAttributes.js';
import { hasModule } from '../license.js';
import { logAuditEvent } from '../auditLog.js';
import { sendServerError } from '../errors.js';

// Kenmerkdefinities (DOEL-75, zie api/src/elementAttributes.ts). Zelfde opzet
// als de controleregels (routes/controlRules.ts): aparte endpoints naast
// /column-config, eigen audit-event (attribute_definitions_updated), en de
// licentiemodule 'controleregels' gate't alleen de kenmerken.
// Sjabloonkenmerken: zie routes/doelenboomTemplates.ts
// (/doelenboom-templates/:id/attributes).
//
// Rechten:
// - lezen: iedereen met (minstens bezoeker-)toegang tot de boom. Zonder
//   actieve module levert de boom-route GEEN definities (zichtbaarheids-
//   principe, licentiemodel §3): ze blijven bewaard maar zijn onzichtbaar;
// - schrijven: requireWritableDoelenboom (admin, respecteert read_only,
//   verlopen licentie en beëindigde tenant) + actieve module;
// - tenant-default: alleen sysadmin, niet module-gegated (sjabloon voor
//   nieuwe bomen), net als de standaardkolommen en -regels.
export const elementAttributesRouter = Router();
elementAttributesRouter.use(requireAuth);

function attributesFromBody(body: unknown): unknown {
  return typeof body === 'object' && body !== null ? (body as { attributes?: unknown }).attributes : undefined;
}

export function attributeAuditDetail(scope: string, attributes: AttributeDef[], extra: Record<string, unknown> = {}) {
  // Alleen id's en aantallen — nooit label/uitleg/keuzelijstwaarden (vrije tekst).
  return { scope, ...extra, attributeCount: attributes.length, attributeIds: attributes.map((a) => a.id) };
}

elementAttributesRouter.get(
  '/doelenbomen/:id/attributes',
  requireTenantRoleForDoelenboomParam('bezoeker', 'id'),
  async (req, res) => {
    const tenantId = await tenantIdForDoelenboom(req.params.id);
    if (tenantId == null) return res.status(404).json({ error: 'Niet gevonden.' });
    const cfg = await pool.query(
      `select attributes from column_configs where scope = 'doelenboom' and doelenboom_id = $1`,
      [req.params.id]
    );
    if (!cfg.rows[0]) return res.status(404).json({ error: 'Doelenboom heeft nog geen kolomconfiguratie.' });
    const columns = await getColumnsForDoelenboom(req.params.id);
    const moduleActive = await hasModule(tenantId, CONTROLE_REGELS_MODULE);
    const attributes = moduleActive ? attributesFromDb(cfg.rows[0].attributes) : [];
    res.json({
      attributes,
      moduleActive,
      validTypeNames: allValidTypeNames(columns),
      // Kenmerken die (na een kolomwijziging zonder actieve module) naar een
      // niet meer bestaand type wijzen — de editor markeert ze; opslaan kan
      // pas als ze hersteld zijn.
      invalidAttributeIds: findAttributesBrokenByColumns(attributes, columns),
      // DOEL-76: aantal ingevulde waarden per kenmerk (en per keuzelijstwaarde),
      // zodat de editor kan waarschuwen dat verwijderen die waarden wist.
      valueCounts: await countValuesPerAttribute(req.params.id, attributes),
    });
  }
);

elementAttributesRouter.put(
  '/doelenbomen/:id/attributes',
  requireWritableDoelenboom('id'),
  requireModule(CONTROLE_REGELS_MODULE, 'id'),
  async (req: AuthedRequest, res) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const cfg = await client.query(
        `select id, tenant_id, attributes from column_configs where scope = 'doelenboom' and doelenboom_id = $1 for update`,
        [req.params.id]
      );
      if (!cfg.rows[0]) {
        await client.query('rollback');
        return res.status(404).json({ error: 'Doelenboom heeft nog geen kolomconfiguratie — neem contact op met support.' });
      }
      const columns = await getColumnsForDoelenboom(req.params.id);
      const { errors, attributes } = validateAttributeDefsInput(
        attributesFromBody(req.body), allValidTypeNames(columns), attributesFromDb(cfg.rows[0].attributes)
      );
      if (errors.length) {
        await client.query('rollback');
        return res.status(400).json({ error: errors.join(' ') });
      }
      await setAttributesForConfigId(client, cfg.rows[0].id, attributes);
      // DOEL-76: waarden van verwijderde kenmerken en verwijderde
      // keuzelijstwaarden direct opruimen, in dezelfde transactie (besluit
      // Charles 3 oktober 2026; de editor waarschuwt vooraf met het aantal).
      const removedValues = await deleteValuesForChangedDefinitions(client, req.params.id, attributes);
      await client.query('commit');
      await logAuditEvent({
        eventType: 'attribute_definitions_updated',
        userId: req.user!.id,
        tenantId: cfg.rows[0].tenant_id,
        doelenboomId: req.params.id,
        detail: attributeAuditDetail('doelenboom', attributes, removedValues ? { removedValues } : {}),
      });
      res.json({ attributes, invalidAttributeIds: [] });
    } catch (err) {
      await client.query('rollback');
      sendServerError(res, err, 'Opslaan van kenmerken mislukt');
    } finally {
      client.release();
    }
  }
);

// Kenmerkwaarden van één element (DOEL-76, zie elementAttributeValues.ts).
// PUT met { values: { <kenmerk-id>: waarde | null } }: de meegestuurde
// kenmerken worden gezet, null of een lege tekst wist de waarde; niet
// genoemde kenmerken blijven ongewijzigd.
// - Rechten zoals de overige boom-inhoud: admin en editor, schrijfbare boom
//   (read_only, verlopen licentie, beëindigde tenant) + actieve module.
// - Pad met elementCODE; het element wordt opgezocht BINNEN de boom uit het
//   pad, dus een element van een andere boom/tenant is onvindbaar (404) —
//   geen IDOR. Door wie/wanneer zet alleen de server; andere velden in de
//   body worden genegeerd.
// - Bewust GEEN audit-event (besluit DOEL-76): het invullen wordt niet
//   gelogd, net als het bewerken van andere elementvelden, en waarden horen
//   nooit in audit_log.
elementAttributesRouter.put(
  '/doelenbomen/:id/elements/:code/attributes',
  requireWritableDoelenboom('id', 'editor'),
  requireModule(CONTROLE_REGELS_MODULE, 'id'),
  async (req: AuthedRequest, res) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const element = await client.query(
        'select id, type from elements where doelenboom_id = $1 and code = $2 for update',
        [req.params.id, req.params.code]
      );
      if (!element.rows[0]) {
        await client.query('rollback');
        return res.status(404).json({ error: 'Element niet gevonden.' });
      }
      const cfg = await client.query(
        `select attributes from column_configs where scope = 'doelenboom' and doelenboom_id = $1 for share`,
        [req.params.id]
      );
      const columns = await getColumnsForDoelenboom(req.params.id);
      // Alleen geldige definities (zie de boomrespons in routes/tree.ts).
      const all = attributesFromDb(cfg.rows[0]?.attributes);
      const broken = new Set(findAttributesBrokenByColumns(all, columns));
      const definitions = all.filter((a) => !broken.has(a.id));
      const body = typeof req.body === 'object' && req.body !== null ? (req.body as { values?: unknown }).values : undefined;
      const { errors, changes } = validateElementValuesInput(body, definitions, element.rows[0].type, columns);
      if (errors.length) {
        await client.query('rollback');
        return res.status(400).json({ error: errors.join(' ') });
      }
      await applyElementValueChanges(client, req.params.id, element.rows[0].id, req.user!.id, changes);
      await client.query('commit');
      const values = await getAttributeValues(req.params.id, definitions, columns, element.rows[0].id);
      res.json({ elementCode: req.params.code, values: values[req.params.code] ?? {} });
    } catch (err) {
      await client.query('rollback');
      sendServerError(res, err, 'Opslaan van kenmerken mislukt');
    } finally {
      client.release();
    }
  }
);

elementAttributesRouter.get('/tenants/:tenantId/attributes', requireSysadmin, async (req, res) => {
  const attributes = await getTenantDefaultAttributes(req.params.tenantId);
  if (attributes == null) return res.status(404).json({ error: 'Tenant heeft nog geen kolomconfiguratie.' });
  const columns = await getTenantDefaultColumns(req.params.tenantId);
  res.json({
    attributes,
    moduleActive: await hasModule(req.params.tenantId, CONTROLE_REGELS_MODULE),
    validTypeNames: allValidTypeNames(columns),
    invalidAttributeIds: findAttributesBrokenByColumns(attributes, columns),
  });
});

elementAttributesRouter.put('/tenants/:tenantId/attributes', requireSysadmin, async (req: AuthedRequest, res) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const cfg = await client.query(
      `select id, attributes from column_configs where scope = 'tenant_default' and tenant_id = $1 for update`,
      [req.params.tenantId]
    );
    if (!cfg.rows[0]) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Tenant heeft nog geen kolomconfiguratie — neem contact op met support.' });
    }
    const columns = await getTenantDefaultColumns(req.params.tenantId);
    const { errors, attributes } = validateAttributeDefsInput(
      attributesFromBody(req.body), allValidTypeNames(columns), attributesFromDb(cfg.rows[0].attributes)
    );
    if (errors.length) {
      await client.query('rollback');
      return res.status(400).json({ error: errors.join(' ') });
    }
    await setAttributesForConfigId(client, cfg.rows[0].id, attributes);
    await client.query('commit');
    await logAuditEvent({
      eventType: 'attribute_definitions_updated',
      userId: req.user!.id,
      tenantId: req.params.tenantId,
      detail: attributeAuditDetail('tenant_default', attributes),
    });
    res.json({ attributes, invalidAttributeIds: [] });
  } catch (err) {
    await client.query('rollback');
    sendServerError(res, err, 'Opslaan van kenmerken mislukt');
  } finally {
    client.release();
  }
});

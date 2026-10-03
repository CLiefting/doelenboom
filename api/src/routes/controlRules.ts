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
  CONTROLE_REGELS_MODULE,
  ControlRule,
  findRulesBrokenByAttributes,
  findRulesBrokenByColumns,
  requiredAttributeRuleIds,
  getTagCategoriesForDoelenboom,
  getTenantDefaultRules,
  rulesFromDb,
  setRulesForConfigId,
  validateControlRulesInput,
} from '../controlRules.js';
import { countDeviationsPerRule, deleteDeviationsForMissingRules } from '../controlRuleDeviations.js';
import { attributesFromDb, getTenantDefaultAttributes } from '../elementAttributes.js';
import { hasModule } from '../license.js';
import { logAuditEvent } from '../auditLog.js';
import { sendServerError } from '../errors.js';

// Controleregels (DOEL-62, zie api/src/controlRules.ts). Bewust APARTE
// endpoints i.p.v. meeliften op /column-config:
// - de licentiemodule 'controleregels' (requireModule) gate't alleen de
//   regels, niet de kolommen — kolommen beheren blijft basisfunctionaliteit;
// - een eigen audit-event (control_rules_updated) per regelwijziging;
// - de bestaande kolom-PUT (en zijn clients) blijft ongewijzigd.
// Sjabloonregels: zie routes/doelenboomTemplates.ts (/doelenboom-templates/:id/control-rules),
// daar hoort de requireManageTemplate-toegangscheck bij.
//
// Rechten (zelfde als kolomconfiguratie, zie routes/columnConfig.ts):
// - lezen: iedereen met (minstens bezoeker-)toegang tot de boom — nodig voor
//   de controleweergave in DOEL-63;
// - schrijven: requireWritableDoelenboom (admin, respecteert read_only,
//   verlopen licentie en beëindigde tenant) + actieve module;
// - tenant-default: alleen sysadmin, net als de standaardkolommen. Niet
//   module-gegated: het is een sjabloon voor nieuwe bomen, de regels worden
//   pas actief in een tenant met de module.
export const controlRulesRouter = Router();
controlRulesRouter.use(requireAuth);

function rulesFromBody(body: unknown): unknown {
  return typeof body === 'object' && body !== null ? (body as { rules?: unknown }).rules : undefined;
}

function auditDetail(scope: string, rules: ControlRule[], extra: Record<string, unknown> = {}) {
  // Alleen id's en aantallen — nooit label/explanation (vrije tekst).
  return { scope, ...extra, ruleCount: rules.length, ruleIds: rules.map((r) => r.id) };
}

controlRulesRouter.get(
  '/doelenbomen/:id/control-rules',
  requireTenantRoleForDoelenboomParam('bezoeker', 'id'),
  async (req, res) => {
    const tenantId = await tenantIdForDoelenboom(req.params.id);
    if (tenantId == null) return res.status(404).json({ error: 'Niet gevonden.' });
    const cfg = await pool.query(
      `select rules, attributes from column_configs where scope = 'doelenboom' and doelenboom_id = $1`,
      [req.params.id]
    );
    if (!cfg.rows[0]) return res.status(404).json({ error: 'Doelenboom heeft nog geen kolomconfiguratie.' });
    const rules = rulesFromDb(cfg.rows[0].rules);
    const columns = await getColumnsForDoelenboom(req.params.id);
    const moduleActive = await hasModule(tenantId, CONTROLE_REGELS_MODULE);
    const attributes = attributesFromDb(cfg.rows[0].attributes);
    res.json({
      rules,
      moduleActive,
      // DOEL-77: de kenmerkdefinities voor het regeltype "Kenmerk voldoet
      // aan…" — zonder module niet (zichtbaarheidsprincipe, zie de
      // attributes-route).
      attributes: moduleActive ? attributes : [],
      validTypeNames: allValidTypeNames(columns),
      tagCategories: await getTagCategoriesForDoelenboom(req.params.id),
      // Regels die (na een kolomwijziging zonder actieve module) naar een niet
      // meer bestaand type wijzen — de editor markeert ze; opslaan kan pas als
      // ze hersteld zijn.
      invalidRuleIds: [...new Set([
        ...findRulesBrokenByColumns(rules, columns),
        ...findRulesBrokenByAttributes(rules, { attributes, columns }),
      ])],
      // DOEL-64: aantal gemotiveerde afwijkingen per regel-id, zodat de editor
      // kan waarschuwen dat het verwijderen van een regel die motivaties wist.
      deviationCounts: await countDeviationsPerRule(req.params.id),
    });
  }
);

controlRulesRouter.put(
  '/doelenbomen/:id/control-rules',
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
      const attributes = attributesFromDb(cfg.rows[0].attributes);
      const { errors, rules } = validateControlRulesInput(rulesFromBody(req.body), allValidTypeNames(columns), { attributes, columns });
      if (errors.length) {
        await client.query('rollback');
        return res.status(400).json({ error: errors.join(' ') });
      }
      await setRulesForConfigId(client, cfg.rows[0].id, rules);
      // DOEL-64: afwijkingen van regels die niet meer bestaan direct opruimen,
      // in dezelfde transactie (besluit Charles 2 oktober 2026). Een regel
      // uitschakelen (enabled=false) laat de afwijkingen staan.
      // DOEL-77: de afwijkingen van de ingebouwde regels voor verplichte kenmerken
      // (req-<kenmerk-id>) horen niet bij deze lijst en blijven staan.
      const removedDeviations = await deleteDeviationsForMissingRules(
        client, req.params.id, [...rules.map((r) => r.id), ...requiredAttributeRuleIds(attributes)]
      );
      await client.query('commit');
      await logAuditEvent({
        eventType: 'control_rules_updated',
        userId: req.user!.id,
        tenantId: cfg.rows[0].tenant_id,
        doelenboomId: req.params.id,
        detail: auditDetail('doelenboom', rules, removedDeviations ? { removedDeviations } : {}),
      });
      res.json({ rules, invalidRuleIds: [] });
    } catch (err) {
      await client.query('rollback');
      sendServerError(res, err, 'Opslaan van controleregels mislukt');
    } finally {
      client.release();
    }
  }
);

controlRulesRouter.get('/tenants/:tenantId/control-rules', requireSysadmin, async (req, res) => {
  const rules = await getTenantDefaultRules(req.params.tenantId);
  if (rules == null) return res.status(404).json({ error: 'Tenant heeft nog geen kolomconfiguratie.' });
  const columns = await getTenantDefaultColumns(req.params.tenantId);
  const attributes = (await getTenantDefaultAttributes(req.params.tenantId)) ?? [];
  res.json({
    rules,
    moduleActive: await hasModule(req.params.tenantId, CONTROLE_REGELS_MODULE),
    attributes,
    validTypeNames: allValidTypeNames(columns),
    tagCategories: [],
    invalidRuleIds: [...new Set([
      ...findRulesBrokenByColumns(rules, columns),
      ...findRulesBrokenByAttributes(rules, { attributes, columns }),
    ])],
  });
});

controlRulesRouter.put('/tenants/:tenantId/control-rules', requireSysadmin, async (req: AuthedRequest, res) => {
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
    const { errors, rules } = validateControlRulesInput(
      rulesFromBody(req.body), allValidTypeNames(columns), { attributes: attributesFromDb(cfg.rows[0].attributes), columns }
    );
    if (errors.length) {
      await client.query('rollback');
      return res.status(400).json({ error: errors.join(' ') });
    }
    await setRulesForConfigId(client, cfg.rows[0].id, rules);
    await client.query('commit');
    await logAuditEvent({
      eventType: 'control_rules_updated',
      userId: req.user!.id,
      tenantId: req.params.tenantId,
      detail: auditDetail('tenant_default', rules),
    });
    res.json({ rules, invalidRuleIds: [] });
  } catch (err) {
    await client.query('rollback');
    sendServerError(res, err, 'Opslaan van controleregels mislukt');
  } finally {
    client.release();
  }
});

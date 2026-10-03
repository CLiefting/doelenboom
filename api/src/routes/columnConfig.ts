import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { requireSysadmin, requireTenantRoleForDoelenboomParam, requireWritableDoelenboom } from '../rbac.js';
import { getColumnsForDoelenboom, getTenantDefaultColumns, replaceColumns, validateColumnsInput } from '../columnConfig.js';
import { sendServerError } from '../errors.js';
import { brokenRulesMessage, CONTROLE_REGELS_MODULE, findRulesBrokenByColumns, rulesFromDb } from '../controlRules.js';
import { attributesFromDb, brokenAttributesMessage, findAttributesBrokenByColumns } from '../elementAttributes.js';
import { hasModule } from '../license.js';

// Kolomconfiguratie: zie docs/kolommen-configuratie-ontwerp.md.
// - /api/tenants/:tenantId/column-config — de tenant-default (het sjabloon
//   waarmee een nieuwe doelenboom binnen die tenant start), sysadmin-only.
// - /api/doelenbomen/:id/column-config — de eigen, onafhankelijke config van
//   die ene doelenboom; lezen mag iedereen met toegang tot de doelenboom
//   (nodig om de boom te kunnen renderen), wijzigen alleen met schrijfrechten
//   (zelfde regels als overige boom-inhoud, zie requireWritableDoelenboom).
export const columnConfigRouter = Router();
columnConfigRouter.use(requireAuth);

columnConfigRouter.get('/tenants/:tenantId/column-config', requireSysadmin, async (req, res) => {
  const columns = await getTenantDefaultColumns(req.params.tenantId);
  res.json({ columns });
});

columnConfigRouter.put('/tenants/:tenantId/column-config', requireSysadmin, async (req, res) => {
  const { errors: inputErrors, columns } = validateColumnsInput((req.body as { columns?: unknown })?.columns);
  if (inputErrors.length) return res.status(400).json({ error: inputErrors.join(' ') });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const cfg = await client.query(
      `select id, rules, attributes from column_configs where scope = 'tenant_default' and tenant_id = $1 for update`,
      [req.params.tenantId]
    );
    if (!cfg.rows[0]) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Tenant heeft nog geen kolomconfiguratie — neem contact op met support.' });
    }
    // Controleregels (DOEL-62): een kolomwijziging die een regel naar een niet
    // (meer) bestaand type laat wijzen wordt geweigerd met de regel-id's —
    // geen stille verwijdering (zie findRulesBrokenByColumns). Bij de
    // tenant-default altijd (de sysadmin ziet de regels in de editor).
    const brokenRuleIds = findRulesBrokenByColumns(rulesFromDb(cfg.rows[0].rules), columns);
    if (brokenRuleIds.length) {
      await client.query('rollback');
      return res.status(409).json({ error: brokenRulesMessage(brokenRuleIds) });
    }
    // Kenmerkdefinities (DOEL-75): zelfde lijn als bij de regels.
    const brokenAttributeIds = findAttributesBrokenByColumns(attributesFromDb(cfg.rows[0].attributes), columns);
    if (brokenAttributeIds.length) {
      await client.query('rollback');
      return res.status(409).json({ error: brokenAttributesMessage(brokenAttributeIds) });
    }
    // Een tenant-default heeft geen eigen elementen, dus geen "nog in gebruik"-check.
    const { errors } = await replaceColumns(client, cfg.rows[0].id, null, columns);
    if (errors.length) {
      await client.query('rollback');
      return res.status(409).json({ error: errors.join(' ') });
    }
    await client.query('commit');
    const fresh = await getTenantDefaultColumns(req.params.tenantId);
    res.json({ columns: fresh });
  } catch (err) {
    await client.query('rollback');
    sendServerError(res, err, 'Opslaan van kolomconfiguratie mislukt');
  } finally {
    client.release();
  }
});

columnConfigRouter.get(
  '/doelenbomen/:id/column-config',
  requireTenantRoleForDoelenboomParam('bezoeker', 'id'),
  async (req, res) => {
    const columns = await getColumnsForDoelenboom(req.params.id);
    res.json({ columns });
  }
);

columnConfigRouter.put(
  '/doelenbomen/:id/column-config',
  requireWritableDoelenboom('id'),
  async (req, res) => {
    const { errors: inputErrors, columns } = validateColumnsInput((req.body as { columns?: unknown })?.columns);
    if (inputErrors.length) return res.status(400).json({ error: inputErrors.join(' ') });

    const client = await pool.connect();
    try {
      await client.query('begin');
      const cfg = await client.query(
        `select id, tenant_id, rules, attributes from column_configs where scope = 'doelenboom' and doelenboom_id = $1 for update`,
        [req.params.id]
      );
      if (!cfg.rows[0]) {
        await client.query('rollback');
        return res.status(404).json({ error: 'Doelenboom heeft nog geen kolomconfiguratie — neem contact op met support.' });
      }
      // Controleregels (DOEL-62): zie de tenant-default-route hierboven. Alleen
      // als de module actief is — zonder module zijn de regels onzichtbaar en
      // gaat de kolomwijziging door; de regel blijft bewaard en wordt bij
      // heractivering in de editor gemarkeerd (besluit Charles, DOEL-62).
      if (await hasModule(cfg.rows[0].tenant_id, CONTROLE_REGELS_MODULE)) {
        const brokenRuleIds = findRulesBrokenByColumns(rulesFromDb(cfg.rows[0].rules), columns);
        if (brokenRuleIds.length) {
          await client.query('rollback');
          return res.status(409).json({ error: brokenRulesMessage(brokenRuleIds) });
        }
        // Kenmerkdefinities (DOEL-75): zelfde lijn, ook alleen met actieve module.
        const brokenAttributeIds = findAttributesBrokenByColumns(attributesFromDb(cfg.rows[0].attributes), columns);
        if (brokenAttributeIds.length) {
          await client.query('rollback');
          return res.status(409).json({ error: brokenAttributesMessage(brokenAttributeIds) });
        }
      }
      const { errors } = await replaceColumns(client, cfg.rows[0].id, req.params.id, columns);
      if (errors.length) {
        await client.query('rollback');
        return res.status(409).json({ error: errors.join(' ') });
      }
      await client.query('commit');
      const fresh = await getColumnsForDoelenboom(req.params.id);
      res.json({ columns: fresh });
    } catch (err) {
      await client.query('rollback');
      sendServerError(res, err, 'Opslaan van kolomconfiguratie mislukt');
    } finally {
      client.release();
    }
  }
);

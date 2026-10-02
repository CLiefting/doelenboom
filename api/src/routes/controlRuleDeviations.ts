import { Router } from 'express';
import { pool } from '../db.js';
import { AuthedRequest, requireAuth } from '../auth.js';
import {
  getEffectiveRoleForDoelenboom,
  requireModule,
  requireTenantRoleForDoelenboomParam,
  requireWritableDoelenboom,
  tenantIdForDoelenboom,
} from '../rbac.js';
import { CONTROLE_REGELS_MODULE, RULE_ID_PATTERN, getRulesForDoelenboom } from '../controlRules.js';
import {
  MOTIVATIE_MAX_LENGTH,
  getDeviation,
  getDeviationsForDoelenboom,
  stripEditorOnlyFields,
} from '../controlRuleDeviations.js';
import { hasModule } from '../license.js';
import { logAuditEvent } from '../auditLog.js';
import { sendServerError } from '../errors.js';

// Gemotiveerde afwijkingen van controleregels (DOEL-64, zie
// api/src/controlRuleDeviations.ts).
//
// Rechten:
// - lezen: iedereen met (minstens bezoeker-)toegang tot de boom; het
//   e-mailadres van de bijwerker alleen voor admin/editor (zelfde privacykeuze
//   als projectstatus). Zonder actieve module: lege lijst
//   (zichtbaarheidsprincipe, net als controlRules in de boomrespons).
// - schrijven: requireWritableDoelenboom met minRole 'editor' (besluit Charles
//   2 oktober 2026: admin én gebruiker/editor; respecteert read_only,
//   verlopen licentie en beëindigde tenant) + actieve module 'controleregels'.
//
// Pad met elementCODE (niet het database-id), zelfde conventie als
// routes/elements.ts/projectStatus.ts. Het element wordt altijd opgezocht
// BINNEN de boom uit het pad (where doelenboom_id = :id and code = :code),
// dus een element van een andere boom/tenant is per constructie onvindbaar
// (404) — geen IDOR.
export const controlRuleDeviationsRouter = Router();
controlRuleDeviationsRouter.use(requireAuth);

const requireEditor = requireWritableDoelenboom('id', 'editor');
const requireControleregelsModule = requireModule(CONTROLE_REGELS_MODULE, 'id');

async function findElementId(doelenboomId: string, code: string): Promise<number | null> {
  const r = await pool.query('select id from elements where doelenboom_id = $1 and code = $2', [doelenboomId, code]);
  return r.rows[0]?.id ?? null;
}

controlRuleDeviationsRouter.get(
  '/doelenbomen/:id/control-rule-deviations',
  requireTenantRoleForDoelenboomParam('bezoeker', 'id'),
  async (req: AuthedRequest, res) => {
    const tenantId = await tenantIdForDoelenboom(req.params.id);
    if (tenantId == null) return res.status(404).json({ error: 'Niet gevonden.' });
    if (!(await hasModule(tenantId, CONTROLE_REGELS_MODULE))) return res.json({ deviations: [] });
    const list = await getDeviationsForDoelenboom(req.params.id);
    const role = await getEffectiveRoleForDoelenboom(req.user!.id, req.params.id);
    const isEditorRole = role === 'admin' || role === 'editor';
    res.json({ deviations: isEditorRole ? list : stripEditorOnlyFields(list) });
  }
);

const DEVIATION_PATH = '/doelenbomen/:id/elements/:code/control-rule-deviations/:ruleId';

// PUT — aanmaken of bijwerken (upsert) met { motivatie }. Alle andere velden
// in de body (created_by, updatedAt, ...) worden genegeerd: door wie/wanneer
// zet alleen de server.
controlRuleDeviationsRouter.put(DEVIATION_PATH, requireEditor, requireControleregelsModule, async (req: AuthedRequest, res) => {
  const ruleId = req.params.ruleId;
  if (!RULE_ID_PATTERN.test(ruleId)) return res.status(400).json({ error: 'Ongeldig regel-id.' });

  const raw = (req.body ?? {}) as Record<string, unknown>;
  if (typeof raw.motivatie !== 'string') return res.status(400).json({ error: 'Motivatie is verplicht.' });
  const motivatie = raw.motivatie.trim();
  if (motivatie.length < 1) return res.status(400).json({ error: 'Motivatie is verplicht.' });
  if (motivatie.length > MOTIVATIE_MAX_LENGTH) {
    return res.status(400).json({ error: `Motivatie mag maximaal ${MOTIVATIE_MAX_LENGTH} tekens zijn.` });
  }

  try {
    const elementId = await findElementId(req.params.id, req.params.code);
    if (!elementId) return res.status(404).json({ error: 'Element niet gevonden.' });

    const rules = (await getRulesForDoelenboom(req.params.id)) ?? [];
    if (!rules.some((r) => r.id === ruleId)) {
      return res.status(400).json({ error: 'Deze controleregel bestaat niet (meer) voor deze doelenboom.' });
    }

    await pool.query(
      `insert into control_rule_deviations (doelenboom_id, element_id, rule_id, motivatie, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $5)
       on conflict (element_id, rule_id) do update set
         motivatie = excluded.motivatie,
         updated_by = excluded.updated_by,
         updated_at = now()`,
      [req.params.id, elementId, ruleId, motivatie, req.user!.id]
    );

    // Audit: alleen elementcode + regel-id, NOOIT de motivatietekst.
    await logAuditEvent({
      eventType: 'control_rule_deviation_set',
      userId: req.user!.id,
      tenantId: await tenantIdForDoelenboom(req.params.id),
      doelenboomId: req.params.id,
      detail: { elementCode: req.params.code, ruleId },
    });

    res.json(await getDeviation(req.params.id, elementId, ruleId));
  } catch (err) {
    sendServerError(res, err, 'Opslaan van de afwijking mislukt');
  }
});

// DELETE — afwijking intrekken; de overtreding wordt weer "open".
controlRuleDeviationsRouter.delete(DEVIATION_PATH, requireEditor, requireControleregelsModule, async (req: AuthedRequest, res) => {
  const ruleId = req.params.ruleId;
  if (!RULE_ID_PATTERN.test(ruleId)) return res.status(400).json({ error: 'Ongeldig regel-id.' });
  try {
    const elementId = await findElementId(req.params.id, req.params.code);
    if (!elementId) return res.status(404).json({ error: 'Element niet gevonden.' });
    const del = await pool.query(
      'delete from control_rule_deviations where doelenboom_id = $1 and element_id = $2 and rule_id = $3',
      [req.params.id, elementId, ruleId]
    );
    if (!del.rowCount) return res.status(404).json({ error: 'Afwijking niet gevonden.' });
    await logAuditEvent({
      eventType: 'control_rule_deviation_removed',
      userId: req.user!.id,
      tenantId: await tenantIdForDoelenboom(req.params.id),
      doelenboomId: req.params.id,
      detail: { elementCode: req.params.code, ruleId },
    });
    res.status(204).end();
  } catch (err) {
    sendServerError(res, err, 'Intrekken van de afwijking mislukt');
  }
});

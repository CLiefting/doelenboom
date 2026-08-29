import { Router } from 'express';
import { AuthedRequest, requireAuth } from '../auth.js';
import {
  getEffectiveRoleForDoelenboom,
  getTenantRole,
  requireTenantRoleForDoelenboomParam,
  requireTenantRoleForTenantParam,
  tenantIdForDoelenboom,
} from '../rbac.js';
import {
  deleteTemplateById,
  getTemplateColumnsWithIds,
  getTemplateTenantId,
  listAllTemplatesForUser,
  listTemplatesForTenant,
  refreshTemplateFromDoelenboom,
  saveDoelenboomAsTemplate,
  updateTemplateColumns,
  updateTemplateMeta,
} from '../doelenboomTemplates.js';

// Doelenboom-sjablonen: zie db/migrations/0014_doelenboom_templates.sql en
// api/src/doelenboomTemplates.ts voor het ontwerp. Beheer is "beide
// gecombineerd" (zie het gesprek): een sysadmin kan systeembrede sjablonen
// opslaan/bewerken/verwijderen, een tenant-admin kan dat voor de eigen
// tenant. Het aparte Sjablonenbeheer-scherm (web/src/pages/
// DoelenboomTemplatesPage.tsx) gebruikt alle routes hieronder behalve de
// eerste (die blijft de per-tenant sjabloonkiezer bij "nieuwe doelenboom").
export const doelenboomTemplatesRouter = Router();
doelenboomTemplatesRouter.use(requireAuth);

// Gedeelde toegangscheck voor alle beheer-routes hieronder (rename/kolommen/
// vervangen/verwijderen): sysadmin mag altijd; een tenant-admin alleen voor
// een sjabloon van de EIGEN tenant, nooit voor een systeembreed sjabloon.
// Stuurt zelf de foutrespons en geeft null terug als de aanroeper moet
// stoppen — anders het sjabloon se tenant_id (null = systeembreed).
async function requireManageTemplate(
  req: AuthedRequest,
  res: import('express').Response,
  templateId: number
): Promise<{ tenantId: number | null } | null> {
  const { found, tenantId } = await getTemplateTenantId(templateId);
  if (!found) {
    res.status(404).json({ error: 'Sjabloon niet gevonden.' });
    return null;
  }
  if (req.user!.isSysadmin) return { tenantId };
  if (tenantId == null) {
    res.status(403).json({ error: 'Alleen een sysadmin kan een systeembreed sjabloon beheren.' });
    return null;
  }
  const role = await getTenantRole(req.user!.id, tenantId);
  if (role !== 'admin') {
    res.status(403).json({ error: 'Alleen een tenant-admin van deze tenant kan dit sjabloon beheren.' });
    return null;
  }
  return { tenantId };
}

// Lijst zichtbare sjablonen voor één tenant (systeembreed + van die tenant
// zelf) — gebruikt om de sjabloonkiezer bij "nieuwe doelenboom" te vullen.
// Zelfde toegang als het aanmaken van een doelenboom zelf (tenant-admin of
// sysadmin): dit is metadata voor die actie, geen boom-inhoud.
doelenboomTemplatesRouter.get(
  '/tenants/:tenantId/doelenboom-templates',
  requireTenantRoleForTenantParam('admin', 'tenantId'),
  async (req, res) => {
    const rows = await listTemplatesForTenant(Number(req.params.tenantId));
    res.json(rows);
  }
);

// Alle sjablonen die déze gebruiker mag beheren, over alle tenants heen —
// voor het aparte Sjablonenbeheer-scherm (i.p.v. eerst een tenant te moeten
// kiezen zoals bij de route hierboven). Geen apart permissie-gate nodig: de
// query zelf filtert al op wat deze gebruiker mag zien (leeg voor iemand die
// nergens tenant-admin is en geen sysadmin is).
doelenboomTemplatesRouter.get('/doelenboom-templates', async (req: AuthedRequest, res) => {
  const rows = await listAllTemplatesForUser(req.user!.id, req.user!.isSysadmin);
  res.json(rows);
});

// Een bestaande doelenboom opslaan als (nieuw) sjabloon. Vereist echte
// admin-toegang tot déze doelenboom (géén automatische sysadmin-bypass —
// dit leest de volledige kolommen/elementen/relaties van de boom, dus
// zelfde privacy-grens als export, zie rbac.ts-rolmodel-comment). scope
// bepaalt of het sjabloon systeembreed wordt (alleen toegestaan als de
// aanroeper zelf sysadmin is) of van deze ene tenant.
doelenboomTemplatesRouter.post(
  '/doelenbomen/:id/save-as-template',
  requireTenantRoleForDoelenboomParam('admin', 'id'),
  async (req: AuthedRequest, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const description = typeof b.description === 'string' ? b.description.trim() : '';
    const scope = b.scope === 'global' ? 'global' : 'tenant';

    if (!name) return res.status(400).json({ error: 'Naam is verplicht.' });
    if (scope === 'global' && !req.user!.isSysadmin) {
      return res.status(403).json({ error: 'Alleen een sysadmin kan een systeembreed sjabloon opslaan.' });
    }

    const tenantId = await tenantIdForDoelenboom(req.params.id);
    if (tenantId == null) return res.status(404).json({ error: 'Doelenboom niet gevonden.' });

    const template = await saveDoelenboomAsTemplate(Number(req.params.id), {
      name,
      description,
      tenantId: scope === 'global' ? null : tenantId,
    });
    res.status(201).json(template);
  }
);

// Naam/omschrijving van een sjabloon aanpassen (Sjablonenbeheer-scherm).
// Beide velden optioneel — alleen meesturen wat je wil wijzigen.
doelenboomTemplatesRouter.put('/doelenboom-templates/:id', async (req: AuthedRequest, res) => {
  const ctx = await requireManageTemplate(req, res, Number(req.params.id));
  if (!ctx) return;

  const b = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : undefined;
  const description = typeof b.description === 'string' ? b.description.trim() : undefined;
  if (name !== undefined && !name) {
    return res.status(400).json({ error: 'Naam mag niet leeg zijn.' });
  }

  const updated = await updateTemplateMeta(Number(req.params.id), { name, description });
  if (!updated) return res.status(404).json({ error: 'Sjabloon niet gevonden.' });
  res.json(updated);
});

// Kolommen van een sjabloon opvragen/bewerken — hergebruikt dezelfde
// <ColumnConfigEditor>-component als de tenant-default- en
// doelenboom-kolommen (web/src/components/ColumnConfigEditor.tsx).
doelenboomTemplatesRouter.get('/doelenboom-templates/:id/column-config', async (req: AuthedRequest, res) => {
  const ctx = await requireManageTemplate(req, res, Number(req.params.id));
  if (!ctx) return;
  const columns = await getTemplateColumnsWithIds(Number(req.params.id));
  if (!columns) return res.status(404).json({ error: 'Sjabloon niet gevonden.' });
  res.json({ columns });
});

doelenboomTemplatesRouter.put('/doelenboom-templates/:id/column-config', async (req: AuthedRequest, res) => {
  const ctx = await requireManageTemplate(req, res, Number(req.params.id));
  if (!ctx) return;
  const { errors, columns } = await updateTemplateColumns(Number(req.params.id), (req.body as { columns?: unknown })?.columns);
  if (errors.length) return res.status(409).json({ error: errors.join(' ') });
  res.json({ columns });
});

// "Inhoud vervangen vanuit een boom" (Sjablonenbeheer-scherm) — overschrijft
// kolommen + elementen + relaties van een bestaand sjabloon met die van de
// gekozen doelenboom. Vereist BEIDE: rechten om dit sjabloon te beheren
// (requireManageTemplate) ÉN echte admin-toegang tot de bronboom zelf (geen
// sysadmin-bypass — zelfde privacy-grens als save-as-template hierboven,
// want dit leest ook de volledige boominhoud).
doelenboomTemplatesRouter.post('/doelenboom-templates/:id/refresh-from-doelenboom', async (req: AuthedRequest, res) => {
  const ctx = await requireManageTemplate(req, res, Number(req.params.id));
  if (!ctx) return;

  const b = (req.body ?? {}) as Record<string, unknown>;
  const doelenboomId = typeof b.doelenboomId === 'number' ? b.doelenboomId : Number(b.doelenboomId);
  if (!doelenboomId || Number.isNaN(doelenboomId)) {
    return res.status(400).json({ error: 'doelenboomId is verplicht.' });
  }

  const sourceRole = await getEffectiveRoleForDoelenboom(req.user!.id, doelenboomId);
  if (sourceRole !== 'admin') {
    return res.status(403).json({ error: 'Je hebt geen admin-toegang tot de gekozen bronboom.' });
  }

  const ok = await refreshTemplateFromDoelenboom(Number(req.params.id), doelenboomId);
  if (!ok) return res.status(404).json({ error: 'Sjabloon niet gevonden.' });
  const columns = await getTemplateColumnsWithIds(Number(req.params.id));
  res.json({ columns });
});

// Sjabloon verwijderen — sysadmin mag altijd (ook systeembrede sjablonen);
// een tenant-admin alleen de sjablonen van de eigen tenant, nooit
// systeembrede. Dit is toegangsbeheer op het sjabloon zelf (metadata), geen
// boom-inhoud lezen — vandaar geen requireTenantRoleForDoelenboomParam hier
// (een sjabloon is niet aan één doelenboom gebonden) maar requireManageTemplate.
doelenboomTemplatesRouter.delete('/doelenboom-templates/:id', async (req: AuthedRequest, res) => {
  const ctx = await requireManageTemplate(req, res, Number(req.params.id));
  if (!ctx) return;
  await deleteTemplateById(Number(req.params.id));
  res.status(204).send();
});

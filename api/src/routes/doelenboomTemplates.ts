import { Router } from 'express';
import { AuthedRequest, requireAuth } from '../auth.js';
import {
  getTenantRole,
  requireTenantRoleForDoelenboomParam,
  requireTenantRoleForTenantParam,
  tenantIdForDoelenboom,
} from '../rbac.js';
import { deleteTemplateById, getTemplateTenantId, listTemplatesForTenant, saveDoelenboomAsTemplate } from '../doelenboomTemplates.js';

// Doelenboom-sjablonen: zie db/migrations/0014_doelenboom_templates.sql en
// api/src/doelenboomTemplates.ts voor het ontwerp. Beheer is "beide
// gecombineerd" (zie het gesprek): een sysadmin kan systeembrede sjablonen
// opslaan/verwijderen, een tenant-admin kan dat voor de eigen tenant.
export const doelenboomTemplatesRouter = Router();
doelenboomTemplatesRouter.use(requireAuth);

// Lijst zichtbare sjablonen voor een tenant (systeembreed + van die tenant
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

// Sjabloon verwijderen — sysadmin mag altijd (ook systeembrede sjablonen);
// een tenant-admin alleen de sjablonen van de eigen tenant, nooit
// systeembrede. Dit is toegangsbeheer op het sjabloon zelf (metadata), geen
// boom-inhoud lezen — vandaar geen requireTenantRoleForDoelenboomParam hier
// (een sjabloon is niet aan één doelenboom gebonden) maar een eigen check.
doelenboomTemplatesRouter.delete('/doelenboom-templates/:id', async (req: AuthedRequest, res) => {
  const { found, tenantId } = await getTemplateTenantId(Number(req.params.id));
  if (!found) return res.status(404).json({ error: 'Sjabloon niet gevonden.' });

  if (!req.user!.isSysadmin) {
    if (tenantId == null) {
      return res.status(403).json({ error: 'Alleen een sysadmin kan een systeembreed sjabloon verwijderen.' });
    }
    const role = await getTenantRole(req.user!.id, tenantId);
    if (role !== 'admin') {
      return res.status(403).json({ error: 'Alleen een tenant-admin van deze tenant kan dit sjabloon verwijderen.' });
    }
  }

  await deleteTemplateById(Number(req.params.id));
  res.status(204).send();
});

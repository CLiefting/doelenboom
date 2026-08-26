import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { requireWritableDoelenboom, requireModule } from '../rbac.js';

// CRUD voor producten/deliverables ("planning items") van een element — tot nu
// toe alleen te vullen via Excel-import (routes/imports.ts); dit hier is de
// directe, meteen zichtbare variant, zelfde opzet als elements.ts/tags.ts.
// Elk planning item heeft een type ('deliverable' of 'mijlpaal', zie
// db/init.sql bij products.type) dat bepaalt welk symbool het krijgt op de
// tijdbalk boven de producten-lijst in het projectpaneel (tree.html).
export const productsRouter = Router();
productsRouter.use(requireAuth);
// Per route meegeven (niet via router.use()) — zie toelichting in elements.ts.
// minRole='gebruiker': producten/deliverables zijn "losse boom-inhoud" bij een
// element, net als elementen/relaties/tags-koppelingen.
const requireEditor = requireWritableDoelenboom('id', 'gebruiker');
// Producten/deliverables horen bij de "Projecten"-module (zie
// doelenboom_licentiemodel.md §3) — GET .../tree levert al lege data als de
// module ontbreekt (routes/tree.ts), dit hier blokkeert daarnaast expliciet
// de schrijfkant met een duidelijke foutmelding i.p.v. een stille no-op.
const requireProjectenModule = requireModule('projecten', 'id');

const PRODUCT_TYPES = ['deliverable', 'mijlpaal'];

// SQL-aliassen zodat de kolomnamen 1-op-1 matchen met wat tree.ts/de frontend
// al verwacht (camelCase), zonder dat de aanroeper zelf hoeft te mappen.
const PRODUCT_SELECT_FIELDS =
  'id, code, name, type, omschrijving, pct_gereed as "pctGereed", ' +
  'verwachte_datum as "verwachteDatum", werkelijke_datum as "werkelijkeDatum", opmerking';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

type ProductInput = {
  errors: string[];
  code: string;
  name: string;
  type: string;
  omschrijving: string;
  pctGereed: number;
  verwachteDatum: string | null;
  werkelijkeDatum: string | null;
  opmerking: string;
};

function readProductBody(body: unknown): ProductInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: string[] = [];
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const type = typeof b.type === 'string' && b.type.trim() ? b.type.trim() : 'deliverable';
  const pctGereed = typeof b.pctGereed === 'number' && Number.isFinite(b.pctGereed) ? Math.round(b.pctGereed) : 0;

  if (!name) errors.push('Naam is verplicht.');
  if (!PRODUCT_TYPES.includes(type)) errors.push(`Type moet één van de volgende zijn: ${PRODUCT_TYPES.join(', ')}.`);
  if (pctGereed < 0 || pctGereed > 100) errors.push('% gereed moet tussen 0 en 100 liggen.');

  return {
    errors,
    code: typeof b.code === 'string' ? b.code.trim() : '',
    name,
    type,
    omschrijving: typeof b.omschrijving === 'string' ? b.omschrijving : '',
    pctGereed,
    verwachteDatum: typeof b.verwachteDatum === 'string' && b.verwachteDatum ? b.verwachteDatum : null,
    werkelijkeDatum: typeof b.werkelijkeDatum === 'string' && b.werkelijkeDatum ? b.werkelijkeDatum : null,
    opmerking: typeof b.opmerking === 'string' ? b.opmerking : '',
  };
}

async function findElementId(doelenboomId: string, code: string): Promise<number | null> {
  const r = await pool.query('select id from elements where doelenboom_id = $1 and code = $2', [doelenboomId, code]);
  return r.rows[0]?.id ?? null;
}

// POST /api/doelenbomen/:id/elements/:code/products — nieuw planning item.
productsRouter.post('/doelenbomen/:id/elements/:code/products', requireEditor, requireProjectenModule, async (req, res) => {
  const input = readProductBody(req.body);
  if (input.errors.length) return res.status(400).json({ error: input.errors.join(' ') });

  const elementId = await findElementId(req.params.id, req.params.code);
  if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

  const result = await pool.query(
    `insert into products (element_id, code, name, type, omschrijving, pct_gereed, verwachte_datum, werkelijke_datum, opmerking)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning ${PRODUCT_SELECT_FIELDS}`,
    [
      elementId, input.code, input.name, input.type, input.omschrijving,
      input.pctGereed, input.verwachteDatum, input.werkelijkeDatum, input.opmerking,
    ]
  );
  res.status(201).json(result.rows[0]);
});

// PUT /api/doelenbomen/:id/elements/:code/products/:productId — bijwerken.
productsRouter.put('/doelenbomen/:id/elements/:code/products/:productId', requireEditor, requireProjectenModule, async (req, res) => {
  const input = readProductBody(req.body);
  if (input.errors.length) return res.status(400).json({ error: input.errors.join(' ') });

  const elementId = await findElementId(req.params.id, req.params.code);
  if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

  const result = await pool.query(
    `update products
     set code = $1, name = $2, type = $3, omschrijving = $4, pct_gereed = $5,
         verwachte_datum = $6, werkelijke_datum = $7, opmerking = $8
     where id = $9 and element_id = $10
     returning ${PRODUCT_SELECT_FIELDS}`,
    [
      input.code, input.name, input.type, input.omschrijving, input.pctGereed,
      input.verwachteDatum, input.werkelijkeDatum, input.opmerking,
      req.params.productId, elementId,
    ]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Planning item niet gevonden.' });
  res.json(result.rows[0]);
});

// DELETE /api/doelenbomen/:id/elements/:code/products/:productId
productsRouter.delete('/doelenbomen/:id/elements/:code/products/:productId', requireEditor, requireProjectenModule, async (req, res) => {
  const elementId = await findElementId(req.params.id, req.params.code);
  if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

  const result = await pool.query('delete from products where id = $1 and element_id = $2 returning id', [
    req.params.productId,
    elementId,
  ]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Planning item niet gevonden.' });
  res.status(204).send();
});

// isUniqueViolation is (nog) niet nodig — products heeft geen unique constraint
// op code — maar wordt hier al voor consistentie met de andere routers
// geëxporteerd/aanwezig gehouden mocht dat later wél komen.
void isUniqueViolation;

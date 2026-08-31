import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, AuthedRequest } from '../auth.js';
import { requireWritableDoelenboom, requireModule } from '../rbac.js';
import { diffFields, logProjectHistory, touchProjectStatusUpdated } from '../projectHistory.js';

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
const DUUR_EENHEDEN = ['d', 'w', 'm', 'y'];

// SQL-aliassen zodat de kolomnamen 1-op-1 matchen met wat tree.ts/de frontend
// al verwacht (camelCase), zonder dat de aanroeper zelf hoeft te mappen.
const PRODUCT_SELECT_FIELDS =
  'id, code, name, type, omschrijving, pct_gereed as "pctGereed", ' +
  'verwachte_datum as "verwachteDatum", werkelijke_datum as "werkelijkeDatum", opmerking, ' +
  'duur, duur_eenheid as "duurEenheid", business_value as "businessValue", deadline';

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
  duur: number | null;
  duurEenheid: string;
  businessValue: number | null;
  deadline: string | null;
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

  // duur: doorlooptijd om dit planning item te realiseren — optioneel, dus
  // leeg/undefined mag (nog niet ingeschat). Bij een ingevulde waarde moet
  // het wél een geheel, niet-negatief getal zijn.
  let duur: number | null = null;
  if (b.duur !== undefined && b.duur !== null && b.duur !== '') {
    const n = Number(b.duur);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) errors.push('Duur moet een geheel, niet-negatief getal zijn.');
    else duur = n;
  }
  const rawEenheid = typeof b.duurEenheid === 'string' && b.duurEenheid.trim() ? b.duurEenheid.trim() : 'd';
  if (!DUUR_EENHEDEN.includes(rawEenheid)) errors.push(`Eenheid moet één van de volgende zijn: ${DUUR_EENHEDEN.join(', ')}.`);

  // businessValue: vrije numerieke inschatting, ook optioneel — decimalen
  // toegestaan (bv. story points als 0.5), geen ondergrens (kan negatief zijn
  // als iemand dat zo wil uitdrukken).
  let businessValue: number | null = null;
  if (b.businessValue !== undefined && b.businessValue !== null && b.businessValue !== '') {
    const n = Number(b.businessValue);
    if (!Number.isFinite(n)) errors.push('Business value moet een getal zijn.');
    else businessValue = n;
  }

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
    duur,
    duurEenheid: DUUR_EENHEDEN.includes(rawEenheid) ? rawEenheid : 'd',
    businessValue,
    deadline: typeof b.deadline === 'string' && b.deadline ? b.deadline : null,
  };
}

async function findElementId(doelenboomId: string, code: string): Promise<number | null> {
  const r = await pool.query('select id from elements where doelenboom_id = $1 and code = $2', [doelenboomId, code]);
  return r.rows[0]?.id ?? null;
}

// id uit een geselecteerde/geretourneerde rij weglaten vóór het diffen: id
// verandert per definitie nooit tussen before/after bij een update (dus zou
// daar toch nooit als wijziging verschijnen), maar bij een create (before=
// null) of delete (after={}) komt het wél als "veld" in de diff terecht —
// een zinloze "id: 20 → gewist"-regel in de historie.
function omitId<T extends Record<string, unknown>>(row: T): Omit<T, 'id'> {
  const { id: _omit, ...rest } = row;
  return rest;
}

// POST /api/doelenbomen/:id/elements/:code/products — nieuw planning item.
// Transactie: de insert + de "verouderd"-touch van het project + de
// history-rij moeten samen slagen of samen mislukken — zie de toelichting in
// api/src/projectHistory.ts (vervolg-interview met Charles: een
// deliverable-wijziging telt ook mee voor de 'verouderd'-markering van het
// PROJECT, niet alleen een directe projectstatus-wijziging).
productsRouter.post('/doelenbomen/:id/elements/:code/products', requireEditor, requireProjectenModule, async (req: AuthedRequest, res) => {
  const input = readProductBody(req.body);
  if (input.errors.length) return res.status(400).json({ error: input.errors.join(' ') });

  const elementId = await findElementId(req.params.id, req.params.code);
  if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await client.query(
      `insert into products (
         element_id, code, name, type, omschrijving, pct_gereed, verwachte_datum, werkelijke_datum, opmerking,
         duur, duur_eenheid, business_value, deadline
       )
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       returning ${PRODUCT_SELECT_FIELDS}`,
      [
        elementId, input.code, input.name, input.type, input.omschrijving,
        input.pctGereed, input.verwachteDatum, input.werkelijkeDatum, input.opmerking,
        input.duur, input.duurEenheid, input.businessValue, input.deadline,
      ]
    );
    const row = result.rows[0];
    await touchProjectStatusUpdated(client, elementId, req.user!.id);
    await logProjectHistory(client, {
      elementId,
      userId: req.user!.id,
      kind: 'product',
      action: 'create',
      label: row.name,
      changes: diffFields(null, omitId(row)),
    });
    await client.query('commit');
    res.status(201).json(row);
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
});

// PUT /api/doelenbomen/:id/elements/:code/products/:productId — bijwerken.
productsRouter.put('/doelenbomen/:id/elements/:code/products/:productId', requireEditor, requireProjectenModule, async (req: AuthedRequest, res) => {
  const input = readProductBody(req.body);
  if (input.errors.length) return res.status(400).json({ error: input.errors.join(' ') });

  const elementId = await findElementId(req.params.id, req.params.code);
  if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const before = await client.query(`select ${PRODUCT_SELECT_FIELDS} from products where id = $1 and element_id = $2`, [
      req.params.productId,
      elementId,
    ]);
    if (before.rows.length === 0) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Planning item niet gevonden.' });
    }
    const result = await client.query(
      `update products
       set code = $1, name = $2, type = $3, omschrijving = $4, pct_gereed = $5,
           verwachte_datum = $6, werkelijke_datum = $7, opmerking = $8,
           duur = $9, duur_eenheid = $10, business_value = $11, deadline = $12
       where id = $13 and element_id = $14
       returning ${PRODUCT_SELECT_FIELDS}`,
      [
        input.code, input.name, input.type, input.omschrijving, input.pctGereed,
        input.verwachteDatum, input.werkelijkeDatum, input.opmerking,
        input.duur, input.duurEenheid, input.businessValue, input.deadline,
        req.params.productId, elementId,
      ]
    );
    const row = result.rows[0];
    await touchProjectStatusUpdated(client, elementId, req.user!.id);
    await logProjectHistory(client, {
      elementId,
      userId: req.user!.id,
      kind: 'product',
      action: 'update',
      label: row.name,
      changes: diffFields(omitId(before.rows[0]), omitId(row)),
    });
    await client.query('commit');
    res.json(row);
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
});

// DELETE /api/doelenbomen/:id/elements/:code/products/:productId
productsRouter.delete('/doelenbomen/:id/elements/:code/products/:productId', requireEditor, requireProjectenModule, async (req: AuthedRequest, res) => {
  const elementId = await findElementId(req.params.id, req.params.code);
  if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const before = await client.query(`select ${PRODUCT_SELECT_FIELDS} from products where id = $1 and element_id = $2`, [
      req.params.productId,
      elementId,
    ]);
    if (before.rows.length === 0) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Planning item niet gevonden.' });
    }
    await client.query('delete from products where id = $1 and element_id = $2', [req.params.productId, elementId]);
    await touchProjectStatusUpdated(client, elementId, req.user!.id);
    await logProjectHistory(client, {
      elementId,
      userId: req.user!.id,
      kind: 'product',
      action: 'delete',
      label: before.rows[0].name,
      changes: diffFields(omitId(before.rows[0]), {}),
    });
    await client.query('commit');
    res.status(204).send();
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
});

// ---- Afhankelijkheden tussen planning items (product_dependencies) ----
// Simpeler dan de afhankelijkheden tussen activiteiten (activities.ts): een
// planning item heeft geen startdatum (alleen een verwachte/werkelijke
// opleverdatum, één moment), dus een FS/SS/FF/SF-type zoals bij activiteiten
// heeft hier geen betekenis — puur "successor hangt af van predecessor",
// zonder type of vertraging. Puur informatief (geen scheduling-engine).
//
// Beide planning items moeten bij hetzelfde project-element (:code) horen —
// afgedwongen hieronder vóór het inserten, net als bij activity-
// afhankelijkheden. Bij verwijderen van een planning item verdwijnen
// bijbehorende afhankelijkheden vanzelf (on delete cascade, zie db/init.sql).
const PRODUCT_DEPENDENCY_SELECT_FIELDS =
  'id, predecessor_id as "predecessorId", successor_id as "successorId"';

// POST .../products/dependencies — { predecessorId, successorId }
productsRouter.post(
  '/doelenbomen/:id/elements/:code/products/dependencies',
  requireEditor,
  requireProjectenModule,
  async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const predecessorId = Number(b.predecessorId);
    const successorId = Number(b.successorId);
    const errors: string[] = [];
    if (!Number.isInteger(predecessorId) || predecessorId <= 0) errors.push('Voorganger is verplicht.');
    if (!Number.isInteger(successorId) || successorId <= 0) errors.push('Opvolger is verplicht.');
    if (Number.isInteger(predecessorId) && Number.isInteger(successorId) && predecessorId === successorId) {
      errors.push('Een planning item kan niet van zichzelf afhangen.');
    }
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });

    const elementId = await findElementId(req.params.id, req.params.code);
    if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

    // Allebei moeten bij dit project-element horen — anders zou een
    // afhankelijkheid dwars door twee verschillende projecten heen kunnen
    // lopen.
    const productRows = await pool.query('select id from products where element_id = $1 and id = any($2::bigint[])', [
      elementId,
      [predecessorId, successorId],
    ]);
    const foundIds = new Set(productRows.rows.map((r) => Number(r.id)));
    if (!foundIds.has(predecessorId) || !foundIds.has(successorId)) {
      return res.status(404).json({ error: 'Voorganger en/of opvolger niet gevonden bij dit project.' });
    }

    try {
      const result = await pool.query(
        `insert into product_dependencies (predecessor_id, successor_id)
         values ($1,$2)
         returning ${PRODUCT_DEPENDENCY_SELECT_FIELDS}`,
        [predecessorId, successorId]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) return res.status(409).json({ error: 'Deze afhankelijkheid bestaat al.' });
      throw err;
    }
  }
);

// DELETE .../products/dependencies/:dependencyId
productsRouter.delete(
  '/doelenbomen/:id/elements/:code/products/dependencies/:dependencyId',
  requireEditor,
  requireProjectenModule,
  async (req, res) => {
    const elementId = await findElementId(req.params.id, req.params.code);
    if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

    const result = await pool.query(
      `delete from product_dependencies
       where id = $1 and predecessor_id in (select id from products where element_id = $2)
       returning id`,
      [req.params.dependencyId, elementId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Afhankelijkheid niet gevonden.' });
    res.status(204).send();
  }
);

import { pool } from './db.js';

// Gedeelde helpers voor de generieke project-wijzigingshistorie (zie
// db/migrations/0022_project_history.sql) — gebruikt door zowel
// routes/projectStatus.ts (kind='status') als routes/products.ts
// (kind='product') en routes/activities.ts (kind='activity'). Zie het
// vervolg-interview met Charles (31 augustus 2026, n.a.v. project
// "Sweepen"): elke wijziging aan projectinhoud (niet alleen de status) moet
// meetellen voor de 'verouderd'-markering van het project én in dezelfde
// historie-tijdlijn terechtkomen.

export type ProjectHistoryKind = 'status' | 'product' | 'activity';
export type ProjectHistoryAction = 'create' | 'update' | 'delete' | 'touch';

// Zowel de gedeelde pool als een transactie-client (pg's Pool en PoolClient
// hebben allebei een structureel gelijke .query-methode) — alle aanroepers
// hieronder werken binnen een transactie (upsert/insert/delete + de
// history-rij moeten samen slagen of samen mislukken), dus in de praktijk is
// dit altijd een client, nooit de pool zelf.
type Queryable = { query: typeof pool.query };

// Zet project_status.updated_at/updated_by bij (upsert, zelfde insert als de
// losse "touch"-actie in projectStatus.ts) — gebruikt door products.ts/
// activities.ts zodat een deliverable-/activiteitwijziging ook meetelt voor
// de 'verouderd'-markering van het PROJECT (isStale() in tree.html), niet
// alleen een directe projectstatus-wijziging zelf. Werkt ook als er nog
// helemaal geen project_status-rij bestaat (nieuw project, nog geen status
// gezet) — die krijgt er dan eentje met verder alleen de kolomdefaults,
// zelfde als de touch-actie.
export async function touchProjectStatusUpdated(client: Queryable, elementId: number, userId: number): Promise<void> {
  await client.query(
    `insert into project_status (element_id, updated_at, updated_by)
     values ($1, now(), $2)
     on conflict (element_id) do update set
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
    [elementId, userId]
  );
}

// Eén rij in de gedeelde project-tijdlijn. changes bevat ALLEEN de
// daadwerkelijk gewijzigde velden (zie diffFields hieronder) — bij een
// touch-achtige actie zonder inhoudelijke wijziging dus een leeg object.
export async function logProjectHistory(
  client: Queryable,
  params: {
    elementId: number;
    userId: number;
    kind: ProjectHistoryKind;
    action: ProjectHistoryAction;
    label?: string;
    changes: Record<string, { from: unknown; to: unknown }>;
  }
): Promise<void> {
  await client.query(
    `insert into project_history (element_id, changed_by, kind, action, label, changes)
     values ($1,$2,$3,$4,$5,$6::jsonb)`,
    [params.elementId, params.userId, params.kind, params.action, params.label ?? '', JSON.stringify(params.changes)]
  );
}

// Bouwt het changes-object door twee platte objecten te vergelijken — alleen
// velden die daadwerkelijk verschillen komen in de output. null/undefined
// worden voor de vergelijking allebei als "geen waarde" behandeld (zodat een
// veld dat ontbrak en nu leeg is, of andersom, niet als een valse wijziging
// telt) — 'before'=null (nog geen rij, dus alle before-velden ontbreken) is
// hiermee ook meteen de "aanmaak"-situatie: elk ingevuld after-veld komt dan
// als {from: null, to: waarde} in de output.
export function diffFields(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...(before ? Object.keys(before) : []), ...Object.keys(after)]);
  keys.forEach((key) => {
    const fromVal = (before ? before[key] : undefined) ?? null;
    const toVal = after[key] ?? null;
    if (fromVal !== toVal) changes[key] = { from: fromVal, to: toVal };
  });
  return changes;
}

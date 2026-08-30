import { pool } from './db.js';

// Juridische documenten (gebruiksvoorwaarden/privacyverklaring) — zie
// db/migrations/0017_legal_and_retention.sql en
// docs/juridische-documenten-en-retentie.md voor het volledige ontwerp. Eén
// duidelijke, beheersbare bron per versie (legal_documents.content) i.p.v.
// hardcoded juridische tekst verspreid over frontendcomponenten — routes/
// legal.ts en LegalPage.tsx lezen allebei uitsluitend hiervandaan.

export type DocType = 'terms' | 'privacy';

export interface LegalDocument {
  id: number;
  docType: DocType;
  version: string;
  effectiveDate: string;
  publishedAt: string | null;
  status: 'draft' | 'published';
  requiresReacceptance: boolean;
  content: string;
}

const DOC_SELECT_FIELDS = `
  id, doc_type as "docType", version,
  to_char(effective_date, 'YYYY-MM-DD') as "effectiveDate",
  published_at as "publishedAt", status,
  requires_reacceptance as "requiresReacceptance", content
`;

// De publieke pagina toont het liefst de gepubliceerde versie; is er (nog)
// geen enkele gepubliceerde versie van dit doc_type (bv. de privacyverklaring
// staat nog als concept klaar, zie §3 van de opdracht — "gebruik dan een
// duidelijke concept/placeholder-status"), dan valt dit terug op de meest
// recente 'draft' zodat de pagina niet leeg is, mét die status zichtbaar voor
// de frontend om als concept te labelen.
export async function getCurrentDocument(docType: DocType): Promise<LegalDocument | null> {
  const published = await pool.query(
    `select ${DOC_SELECT_FIELDS} from legal_documents
     where doc_type = $1 and status = 'published'
     order by published_at desc limit 1`,
    [docType]
  );
  if (published.rows[0]) return published.rows[0];

  const draft = await pool.query(
    `select ${DOC_SELECT_FIELDS} from legal_documents
     where doc_type = $1
     order by created_at desc limit 1`,
    [docType]
  );
  return draft.rows[0] ?? null;
}

export async function getDocumentById(id: number | string): Promise<LegalDocument | null> {
  const result = await pool.query(`select ${DOC_SELECT_FIELDS} from legal_documents where id = $1`, [id]);
  return result.rows[0] ?? null;
}

// Heeft deze gebruiker de op dit moment GELDENDE voorwaarden al geaccepteerd?
// Alleen 'terms' blokkeert app-gebruik (zie §5/§6 van de opdracht — de
// privacyverklaring is puur informatief, geen aparte acceptatieplicht).
// true (geen blokkade) wanneer er nog helemaal geen gepubliceerde
// voorwaarden-versie bestaat — er valt dan niets te accepteren.
export async function needsTermsAcceptance(userId: number): Promise<boolean> {
  const current = await getCurrentDocument('terms');
  if (!current || current.status !== 'published') return false;

  const accepted = await pool.query(
    'select 1 from legal_acceptances where user_id = $1 and legal_document_id = $2',
    [userId, current.id]
  );
  if (accepted.rows.length > 0) return false;

  // Nog niet geaccepteerd door deze gebruiker. Als dit niet de eerste versie
  // is (er bestaat een oudere, door deze gebruiker wél geaccepteerde versie)
  // én de huidige versie vereist geen heracceptatie, dan blokkeren we niet —
  // zie §6 van de opdracht (requires_reacceptance = false laat bestaand
  // gebruik ongemoeid).
  if (!current.requiresReacceptance) {
    const acceptedAnyOlder = await pool.query(
      `select 1 from legal_acceptances la
       join legal_documents ld on ld.id = la.legal_document_id
       where la.user_id = $1 and ld.doc_type = 'terms' and ld.id != $2`,
      [userId, current.id]
    );
    if (acceptedAnyOlder.rows.length > 0) return false;
  }

  return true;
}

export class LegalAcceptanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegalAcceptanceError';
  }
}

// Registreert acceptatie van de op dit moment geldende voorwaarden door
// PRECIES deze gebruiker — userId komt altijd uit het geverifieerde JWT
// (req.user!.id in routes/legal.ts), nooit uit de request body, zodat een
// gebruiker nooit voor een ander kan accepteren (zie §5/§20 van de opdracht).
export async function acceptCurrentTerms(userId: number): Promise<LegalDocument> {
  const current = await getCurrentDocument('terms');
  if (!current || current.status !== 'published') {
    throw new LegalAcceptanceError('Er zijn op dit moment geen te accepteren gebruiksvoorwaarden.');
  }
  await pool.query(
    `insert into legal_acceptances (user_id, legal_document_id)
     values ($1, $2)
     on conflict (user_id, legal_document_id) do nothing`,
    [userId, current.id]
  );
  return current;
}

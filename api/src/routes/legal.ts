import { Router } from 'express';
import { AuthedRequest, requireAuth } from '../auth.js';
import { acceptCurrentTerms, DocType, getCurrentDocument, LegalAcceptanceError, needsTermsAcceptance } from '../legal.js';

// Gebruiksvoorwaarden + privacyverklaring — zie legal.ts en
// docs/juridische-documenten-en-retentie.md. GET is bewust ongeauthenticeerd
// (net als announcementRouter): beide documenten moeten zonder in te loggen
// bereikbaar zijn (§2/§3 van de opdracht), vandaar mounten vóór de generieke
// '/api'-routers in app.ts, zelfde reden als daar toegelicht.
export const legalRouter = Router();

function parseDocType(raw: string): DocType | null {
  return raw === 'terms' || raw === 'privacy' ? raw : null;
}

legalRouter.get('/legal/:type', async (req, res) => {
  const docType = parseDocType(req.params.type);
  if (!docType) return res.status(404).json({ error: 'Onbekend documenttype.' });
  const doc = await getCurrentDocument(docType);
  if (!doc) return res.status(404).json({ error: 'Dit document is nog niet beschikbaar.' });
  res.json(doc);
});

// Heeft de ingelogde gebruiker de geldende voorwaarden al geaccepteerd? Los
// endpoint i.p.v. alleen via GET /api/auth/me, zodat TermsAcceptanceGate.tsx
// dit ook opnieuw kan checken ná het accepteren, zonder de hele sessie/
// gebruiker opnieuw op te hoeven halen.
legalRouter.get('/legal/terms/status', requireAuth, async (req: AuthedRequest, res) => {
  res.json({ acceptanceRequired: await needsTermsAcceptance(req.user!.id) });
});

// POST /api/legal/terms/accept — userId komt altijd uit het token
// (req.user!.id), nooit uit de request body: een gebruiker kan zo nooit
// acceptatie namens een ander registreren (§5/§20 van de opdracht).
legalRouter.post('/legal/terms/accept', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const doc = await acceptCurrentTerms(req.user!.id);
    res.json({ accepted: true, version: doc.version });
  } catch (err) {
    if (err instanceof LegalAcceptanceError) return res.status(409).json({ error: err.message });
    res.status(500).json({ error: 'Accepteren mislukt', detail: (err as Error).message });
  }
});

import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, AuthedRequest } from '../auth.js';
import { requireSysadmin } from '../rbac.js';

// Eén systeembrede mededeling (bv. "Onderhoud gepland op ..., log op tijd
// uit") — zie db/init.sql system_announcements (singleton-tabel, altijd
// precies één rij). Sysadmin zet 'm aan/uit en bepaalt de tekst; alle andere
// gebruikers (en zelfs uitgelogde bezoekers, zie GET hieronder) zien 'm alleen.
export const announcementRouter = Router();

// GEEN requireAuth hier: een onderhoudsmelding moet ook zichtbaar zijn vóórdat
// iemand inlogt (web/src/pages/LoginPage.tsx) — juist dan is "log niet in, er
// is zo onderhoud" nuttig. Bevat geen gevoelige data (alleen de mededeling
// zelf), dus geen enkel risico om dit ongeauthenticeerd te tonen.
announcementRouter.get('/', async (_req, res) => {
  const result = await pool.query(
    'select message, active, updated_at from system_announcements where id = true'
  );
  const row = result.rows[0] ?? { message: '', active: false, updated_at: null };
  res.json({ message: row.message, active: row.active, updatedAt: row.updated_at });
});

// PUT /api/announcement — { message: string, active: boolean }. Sysadmin-only.
// Overschrijft altijd de ene singleton-rij (geen historie/log bijgehouden —
// dit is een simpele aan/uit-mededeling, geen aankondigingen-archief).
announcementRouter.put('/', requireAuth, requireSysadmin, async (req: AuthedRequest, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const message = typeof b.message === 'string' ? b.message.trim() : '';
  const active = typeof b.active === 'boolean' ? b.active : undefined;
  if (active === undefined) {
    return res.status(400).json({ error: 'active (boolean) is verplicht.' });
  }
  if (active && !message) {
    return res.status(400).json({ error: 'Een actieve mededeling heeft een tekst nodig.' });
  }

  const result = await pool.query(
    `update system_announcements
       set message = $1, active = $2, updated_at = now(), updated_by = $3
     where id = true
     returning message, active, updated_at`,
    [message, active, req.user!.id]
  );
  const row = result.rows[0];
  res.json({ message: row.message, active: row.active, updatedAt: row.updated_at });
});

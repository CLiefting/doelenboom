import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { requireSysadmin } from '../rbac.js';

// GET /api/sessions — sysadmin-only overzicht van wie er is ingelogd (geweest)
// en wanneer: ALLE rijen in de sessions-tabel (zie db/init.sql), nieuwste
// eerst — bewust geen limit, dit is een volledig audit-overzicht.
// 'active' is een eenvoudige, globale interpretatie (niet de per-tenant
// wipe-timeout uit tenantWipe.ts, die gaat over iets anders): een sessie telt
// hier als actief zolang 'm niet expliciet beëindigd is (ended_at is null) én
// de laatste heartbeat niet langer dan 5 minuten geleden was — de frontend
// stuurt elke minuut een heartbeat zolang de tab open is, dus 5 minuten is een
// ruime marge voordat een sessie als "verlaten" geldt.
export const sessionsRouter = Router();
sessionsRouter.use(requireAuth, requireSysadmin);

sessionsRouter.get('/', async (_req, res) => {
  const result = await pool.query(`
    select
      s.id as session_id,
      u.id as user_id,
      u.email,
      u.is_sysadmin,
      s.created_at,
      s.last_seen_at,
      s.ended_at,
      (s.ended_at is null and s.last_seen_at > now() - interval '5 minutes') as active
    from sessions s
    join users u on u.id = s.user_id
    order by s.last_seen_at desc
  `);

  res.json(
    result.rows.map((row) => ({
      sessionId: row.session_id,
      userId: row.user_id,
      email: row.email,
      isSysadmin: row.is_sysadmin,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      endedAt: row.ended_at,
      active: row.active,
    }))
  );
});

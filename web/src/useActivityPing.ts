import { useEffect } from 'react';
import { api } from './api';

// 15-minuten-inactiviteit-beveiliging (zie api/src/auth.ts IDLE_TIMEOUT_MINUTES
// en POST /api/auth/activity): dit is bewust ANDERS dan de heartbeat in
// App.tsx (elke minuut, ongeacht activiteit — "is de tab open", voedt
// sessions.last_seen_at / tenantWipe.ts). Hier gaat het om écht handelen
// (muis, toetsenbord, scroll, touch) — anders zou een open-maar-inactieve tab
// de beveiliging zinloos maken, omdat de blinde heartbeat 'm dan voor altijd
// "vers" zou houden.
//
// Throttled tot maximaal 1x per minuut: niet elke muisbeweging hoeft een
// eigen API-call te zijn, alleen "er is de afgelopen periode iets gebeurd".
//
// Let op: het grootste deel van de daadwerkelijke interactie gebeurt ín de
// tree.html-iframe (TreePage), en muis-/toetsenbordevents dáár bubbelen niet
// door naar dit parent-window. Daarom heeft tree.html zijn eigen, identieke
// activity-ping-logica (zie web/public/tree.html) — deze hook dekt alleen de
// React-schermen zelf (picker, beheer, etc.).
const THROTTLE_MS = 60_000;
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'wheel'] as const;

export function useActivityPing(token: string | null) {
  useEffect(() => {
    if (!token) return;

    let lastPing = 0;
    function onActivity() {
      const now = Date.now();
      if (now - lastPing < THROTTLE_MS) return;
      lastPing = now;
      api.recordActivity(token!).catch(() => {});
    }

    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, onActivity, { passive: true });
    }
    return () => {
      for (const evt of ACTIVITY_EVENTS) {
        window.removeEventListener(evt, onActivity);
      }
    };
  }, [token]);
}

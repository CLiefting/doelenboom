import { useEffect, useState } from 'react';
import { api } from '../api';
import type { User } from '../types';

// Sysadmin-only mededeling boven elke pagina zolang er openstaande
// abonnementsaanvragen/-verlengingen zijn (zie subscriptions.ts
// countPendingSubscriptionActions) — dezelfde plek en balkstijl als
// AnnouncementBanner (onderhoudsmededeling), maar dan voor iets dat de
// sysadmin zelf moet behandelen i.p.v. een mededeling aan alle gebruikers.
// Bewust GEEN sluitknop: dit is een to-do, geen eenmalige mededeling — hij
// verdwijnt vanzelf zodra alle aanvragen/verlengingen behandeld zijn.
const POLL_INTERVAL_MS = 60_000;

export default function PendingSubscriptionsBanner({
  token,
  user,
  onOpenRequests,
}: {
  token: string | null;
  user: User | null;
  onOpenRequests: () => void;
}) {
  const [pending, setPending] = useState<{ pendingRequests: number; upcomingRenewals: number } | null>(null);

  useEffect(() => {
    if (!token || !user?.isSysadmin) {
      setPending(null);
      return;
    }
    let cancelled = false;
    function load() {
      api
        .subscriptionRequestsPendingCount(token!)
        .then((c) => {
          if (!cancelled) setPending(c);
        })
        .catch(() => {});
    }
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [token, user?.isSysadmin]);

  if (!token || !user?.isSysadmin || !pending) return null;
  const total = pending.pendingRequests + pending.upcomingRenewals;
  if (total === 0) return null;

  const parts: string[] = [];
  if (pending.pendingRequests > 0) {
    parts.push(`${pending.pendingRequests} nieuwe aanvra${pending.pendingRequests === 1 ? 'ag' : 'gen'}`);
  }
  if (pending.upcomingRenewals > 0) {
    parts.push(`${pending.upcomingRenewals} naderende verlenging${pending.upcomingRenewals === 1 ? '' : 'en'}`);
  }

  return (
    <div style={styles.banner} role="alert">
      <span style={styles.text}>📋 {parts.join(' en ')} wachten op behandeling.</span>
      <button onClick={onOpenRequests} style={styles.actionBtn}>
        Bekijken →
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // Zelfde opzet als AnnouncementBanner.tsx (geen position:fixed, gewoon een
  // blok bovenaan de flex-kolom in App.tsx) — zie de toelichting daar.
  banner: {
    flexShrink: 0, width: '100%', zIndex: 10,
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16,
    background: '#FFF3CD', borderBottom: '1px solid #FFE69C', color: '#664d03',
    padding: '0.6rem 1rem', fontSize: 14, fontWeight: 600,
    fontFamily: 'system-ui, sans-serif', boxSizing: 'border-box',
    textAlign: 'center', flexWrap: 'wrap',
  },
  text: { flex: '0 1 auto' },
  actionBtn: {
    border: '1px solid #664d03', background: 'transparent', color: '#664d03', cursor: 'pointer',
    fontSize: 13, fontWeight: 700, padding: '4px 10px', borderRadius: 999, fontFamily: 'inherit',
  },
};

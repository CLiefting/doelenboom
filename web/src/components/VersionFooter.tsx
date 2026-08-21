import { useEffect, useState } from 'react';
import { api } from '../api';

// Klein, niet-storend versienummer rechtsonder in beeld — zichtbaar op elk
// scherm, inclusief de boomweergave (die zelf een full-screen <iframe> is,
// zie TreePage.tsx): position:fixed + een hoge z-index laat dit gewoon boven
// het iframe uit steken, dus dit component hoeft maar op één plek (App.tsx)
// gerenderd te worden. pointer-events:none zodat het nooit een klik op de
// boom eronder wegvangt. Haalt de versie maar één keer op (die verandert
// toch niet tijdens een sessie) bij GET /api/version (api/src/index.ts),
// gevuld vanuit de BUILD_VERSION Docker build-arg (zie api/Dockerfile).
export default function VersionFooter() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    api.version().then((r) => setVersion(r.version)).catch(() => {});
  }, []);

  if (!version) return null;

  return (
    <div
      style={{
        position: 'fixed',
        right: 8,
        bottom: 6,
        zIndex: 2147483647,
        fontSize: 10.5,
        color: '#9aa1ab',
        background: 'rgba(255,255,255,0.72)',
        padding: '1px 6px',
        borderRadius: 4,
        pointerEvents: 'none',
        userSelect: 'none',
        fontFamily: 'monospace',
      }}
    >
      v{version}
    </div>
  );
}

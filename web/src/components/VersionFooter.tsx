import { useEffect, useState } from 'react';
import { api } from '../api';

// Klein, niet-storend versienummer rechtsonder in beeld — zichtbaar op elk
// scherm, inclusief de boomweergave (die zelf een full-screen <iframe> is,
// zie TreePage.tsx): position:fixed + een hoge z-index laat dit gewoon boven
// het iframe uit steken, dus dit component hoeft maar op één plek (App.tsx)
// gerenderd te worden. pointer-events:none op de buitenste rij zodat het
// nooit een klik op de boom eronder wegvangt — alleen de losse linkjes
// zelf krijgen pointer-events:auto terug. Haalt de versie maar één keer op
// (die verandert toch niet tijdens een sessie) bij GET /api/version
// (api/src/index.ts), gevuld vanuit de BUILD_VERSION Docker build-arg (zie
// api/Dockerfile).
//
// onLegalRequest (optioneel): als meegegeven, toont dit ook twee kleine
// linkjes naar de gebruiksvoorwaarden/privacyverklaring — hiermee is
// LegalPage vanaf ELK scherm bereikbaar (ingelogd én uitgelogd, App.tsx
// rendert dit component op beide plekken), zie §19 van de opdracht
// ("reachable from the footer").
export default function VersionFooter({
  onLegalRequest,
}: {
  onLegalRequest?: (type: 'terms' | 'privacy') => void;
}) {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    api.version().then((r) => setVersion(r.version)).catch(() => {});
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        right: 8,
        bottom: 6,
        zIndex: 2147483647,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        pointerEvents: 'none',
      }}
    >
      {onLegalRequest && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            fontSize: 10.5,
            background: 'rgba(255,255,255,0.72)',
            padding: '1px 6px',
            borderRadius: 4,
          }}
        >
          <button type="button" onClick={() => onLegalRequest('terms')} style={footerLinkStyle}>
            Voorwaarden
          </button>
          <button type="button" onClick={() => onLegalRequest('privacy')} style={footerLinkStyle}>
            Privacy
          </button>
        </div>
      )}
      {version && (
        <div
          style={{
            fontSize: 10.5,
            color: '#9aa1ab',
            background: 'rgba(255,255,255,0.72)',
            padding: '1px 6px',
            borderRadius: 4,
            userSelect: 'none',
            fontFamily: 'monospace',
          }}
        >
          v{version}
        </div>
      )}
    </div>
  );
}

const footerLinkStyle: React.CSSProperties = {
  pointerEvents: 'auto',
  background: 'none',
  border: 'none',
  padding: 0,
  margin: 0,
  cursor: 'pointer',
  color: '#6c6f76',
  textDecoration: 'underline',
  fontSize: 10.5,
  fontFamily: 'system-ui, sans-serif',
};

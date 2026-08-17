import { useEffect, useRef } from 'react';
import { API_URL } from '../api';
import type { DoelenboomSummary, User } from '../types';

// De echte boomweergave (kolommen, verbindingslijnen, klik-highlight, focus-modus,
// zoeken, tags/org-filter, RAG-markers, SVG-export, sticky topbar) draait in
// web/public/tree.html — een aangepaste versie van de oorspronkelijke doelenboom.html
// die dezelfde CSS en interactielogica hergebruikt, maar zijn data via de API ophaalt
// in plaats van uit hardcoded consts. Dit component is alleen de brug: het geeft het
// token, de doelenboom-id en het e-mailadres van de ingelogde gebruiker (voor de
// topbar) door via postMessage (nooit via de URL) en vertaalt navigatieverzoeken
// vanuit het iframe terug naar React-navigatie.
export default function TreePage({
  token,
  user,
  doelenboom,
  onBack,
  onImport,
  onLogoutRequest,
}: {
  token: string;
  user: User;
  doelenboom: DoelenboomSummary;
  onBack: () => void;
  onImport: () => void;
  onLogoutRequest: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Sysadmin mag overal wijzigen (UI-technisch behandeld als 'admin'); anders de
  // rol die deze gebruiker heeft in de tenant van déze doelenboom, tenzij de
  // doelenboom zelf op read_only staat — dan geldt voor iedereen behalve
  // sysadmin altijd 'gebruiker' (alleen lezen), ook voor een tenant-admin (zie
  // db/init.sql bij doelenbomen.read_only en requireWritableDoelenboom in
  // api/src/rbac.ts, die dit ook server-side afdwingt). 'gebruiker' is verder de
  // veilige fallback mocht er onverwacht geen rol gevonden worden — de API dekt
  // de daadwerkelijke autorisatie sowieso al af, dit hier bepaalt alleen welke
  // knoppen tree.html toont.
  const role: 'admin' | 'gebruiker' = user.isSysadmin
    ? 'admin'
    : doelenboom.read_only
    ? 'gebruiker'
    : user.tenantRoles.find((r) => r.tenantId === doelenboom.tenant_id)?.role ?? 'gebruiker';

  useEffect(() => {
    function sendInit() {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'doelenboom-init', apiUrl: API_URL, token, doelenboomId: doelenboom.id, userEmail: user.email, role },
        window.location.origin
      );
    }

    function handleMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (!event.data || typeof event.data !== 'object') return;

      if (event.data.type === 'doelenboom-ready') {
        sendInit();
      } else if (event.data.type === 'doelenboom-navigate') {
        if (event.data.target === 'picker') onBack();
        else if (event.data.target === 'import') onImport();
        else if (event.data.target === 'logout') onLogoutRequest();
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [token, user.email, doelenboom.id, doelenboom.tenant_id, role, onBack, onImport, onLogoutRequest]);

  return (
    <iframe
      ref={iframeRef}
      src={`/tree.html?doelenboom=${doelenboom.id}`}
      title={`Doelenboom — ${doelenboom.name}`}
      style={{ border: 'none', width: '100vw', height: '100vh', display: 'block' }}
    />
  );
}

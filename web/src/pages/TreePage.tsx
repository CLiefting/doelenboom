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
  onHelpRequest,
}: {
  token: string;
  user: User;
  doelenboom: DoelenboomSummary;
  onBack: () => void;
  onImport: () => void;
  onLogoutRequest: () => void;
  onHelpRequest: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Alleen een voorlopige gok vóórdat tree.html de echte boomdata heeft
  // opgehaald: de rol hangt niet alleen af van de tenant-brede rol en
  // doelenboom.read_only, maar kan ook per doelenboom overruled zijn (zie
  // doelenboom_user_roles / getEffectiveRoleForDoelenboom in api/src/rbac.ts)
  // — dat weet dit component niet, dus laten we tree.html zelf de knop-
  // zichtbaarheid corrigeren zodra GET .../tree binnen is (boot() roept daar
  // applyRole aan op basis van canWrite/canWriteContent). Deze voorlopige
  // waarde voorkomt alleen een korte flits van de verkeerde UI vlak na het
  // laden — de daadwerkelijke autorisatie wordt sowieso altijd server-side
  // afgedwongen, ongeacht wat hier staat. Altijd 'bezoeker' als gok, ook voor
  // sysadmin: sysadmin heeft standaard GEEN toegang tot boom-inhoud (privacy,
  // zie rbac.ts) tenzij zelf als admin/gebruiker/bezoeker aan deze tenant
  // gekoppeld — 'admin' gokken zou hier dus vaker fout dan goed zijn.
  const role: 'bezoeker' = 'bezoeker';

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
        else if (event.data.target === 'help') onHelpRequest();
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [token, user.email, doelenboom.id, role, onBack, onImport, onLogoutRequest, onHelpRequest]);

  return (
    <iframe
      ref={iframeRef}
      src={`/tree.html?doelenboom=${doelenboom.id}`}
      title={`Doelenboom — ${doelenboom.name}`}
      // 100% i.p.v. een vaste 100vw/100vh: die vaste viewport-eenheden hielden
      // geen rekening met de systeemmelding-banner (AnnouncementBanner, zie
      // App.tsx) die er eventueel bovenaan gerenderd wordt — de iframe schoof
      // dan gewoon door tót de bovenkant van de viewport, óók als daar al de
      // banner stond, met als gevolg dat die de topbar (met "Terug"/"Filters"/
      // "Uitloggen"/"Help") aan het zicht onttrok. Nu vult de iframe exact zijn
      // ouder (de flex:1-contentcontainer in App.tsx), die zelf al rekening
      // houdt met de bannerhoogte.
      style={{ border: 'none', width: '100%', height: '100%', display: 'block' }}
    />
  );
}

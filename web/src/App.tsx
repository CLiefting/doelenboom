import { useEffect, useRef, useState } from 'react';
import LoginPage from './pages/LoginPage';
import SubscriptionRequestPage from './pages/SubscriptionRequestPage';
import PickerPage from './pages/PickerPage';
import TreePage from './pages/TreePage';
import ImportPage from './pages/ImportPage';
import TenantManagementPage from './pages/TenantManagementPage';
import DoelenboomTemplatesPage from './pages/DoelenboomTemplatesPage';
import SubscriptionRequestsPage from './pages/SubscriptionRequestsPage';
import AccountManagementPage from './pages/AccountManagementPage';
import LicenseCatalogPage from './pages/LicenseCatalogPage';
import ChangePasswordPage from './pages/ChangePasswordPage';
import HelpPage from './pages/HelpPage';
import AboutPage from './pages/AboutPage';
import LogoutFlow from './components/LogoutFlow';
import VersionFooter from './components/VersionFooter';
import AnnouncementBanner from './components/AnnouncementBanner';
import PendingSubscriptionsBanner from './components/PendingSubscriptionsBanner';
import { api } from './api';
import { useSession } from './useSession';
import { useActivityPing } from './useActivityPing';
import type { DoelenboomSummary } from './types';

// Sessionstorage-sleutel waarmee api.ts (request()) een logout-reden aan de
// volgende pageload doorgeeft — zie AUTH_NOTICE_KEY in api.ts. Alleen gezet
// voor 'idle_timeout'/'session_ended', zodat LoginPage kan uitleggen waaróm
// iemand terug is op het inlogscherm i.p.v. dat gewoon stilzwijgend te laten
// gebeuren.
const AUTH_NOTICE_KEY = 'doelenboom.authNotice';

type View =
  | { name: 'picker' }
  | { name: 'tree' }
  | { name: 'import' }
  | { name: 'tenants' }
  | { name: 'templates' }
  | { name: 'subscription-requests' }
  | { name: 'accounts' }
  | { name: 'licenses' }
  | { name: 'password' }
  // 'from' onthoudt vanaf welk scherm Help geopend is (picker of tree), zodat
  // "Terug" daar weer naartoe kan — Help is vanuit beide bereikbaar.
  | { name: 'help'; from: 'picker' | 'tree' };

const HEARTBEAT_INTERVAL_MS = 60_000;

// Flex-kolom over de volledige viewporthoogte: AnnouncementBanner (normale
// flow, geen position:fixed meer — zie dat component) hoort bovenaan en duwt
// de rest gewoon naar beneden. De inhoud daaronder krijgt via flex:1 exact de
// resterende hoogte (dus 100vh min de bannerhoogte, of gewoon 100vh als er
// geen banner actief is) — belangrijk voor TreePage.tsx, die zijn <iframe>
// (tree.html) op 100% van déze container laat meeschalen i.p.v. een vaste
// 100vh, anders zou de banner alsnog de topbar van de boomweergave verbergen.
const pageStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', height: '100vh' };
const contentAreaStyle: React.CSSProperties = { flex: '1 1 auto', minHeight: 0, overflow: 'auto' };

export default function App() {
  const { session, setSession } = useSession();
  const [doelenboom, setDoelenboom] = useState<DoelenboomSummary | null>(null);
  const [view, setView] = useState<View>({ name: 'picker' });
  // Losse overlay-state i.p.v. in PickerPage: zo kan "Uitloggen" ook vanuit de
  // boomweergave (tree.html, via postMessage) dezelfde flow starten, ongeacht
  // welk scherm er op dat moment getoond wordt.
  const [loggingOut, setLoggingOut] = useState(false);
  // Alleen relevant zolang er nog geen sessie is (zie de !session-tak
  // hieronder) — welk van de twee publieke schermen getoond wordt: het
  // inlogscherm zelf, de aanvraagpagina, of de bevestiging na het indienen.
  const [publicView, setPublicView] = useState<
    { name: 'login' } | { name: 'signup' } | { name: 'signup-done'; email: string } | { name: 'about' }
  >({ name: 'login' });
  // Eénmalig (bij eerste render) uitgelezen én meteen gewist — een sessionStorage-
  // "boodschap voor de volgende load", niet iets dat blijvend in state hoort te
  // hangen (anders zou 'ie bij een latere, ongerelateerde 401 blijven staan).
  const [authNotice] = useState<string | null>(() => {
    const notice = sessionStorage.getItem(AUTH_NOTICE_KEY);
    if (notice) sessionStorage.removeItem(AUTH_NOTICE_KEY);
    return notice;
  });
  // Ingelogd, geen enkele doelenboom (bv. een gloednieuwe tenant via de
  // zelfbedieningsaanvraag, of een tenant waarvan alle bomen inmiddels
  // verwijderd zijn) én de gebruiker is ergens admin: dan is de lege
  // doelenboom-kiezer hieronder ("Nog geen doelenbomen beschikbaar.") geen
  // zinnig startscherm — open in plaats daarvan meteen Tenantbeheer, waar
  // "Maak hier uw eerste doelenboom aan" staat (zie TenantManagementPage).
  // Eénmalig per login (autoRedirectDoneRef) — anders zou "← Terug" naar de
  // nog altijd lege kiezer weer meteen terugklappen naar Tenantbeheer, en zo
  // zou een gebruiker via de UI nooit meer bij bv. "Uitloggen" (dat zit in
  // PickerPage se gebruikersmenu, niet in Tenantbeheer) kunnen komen.
  const autoRedirectDoneRef = useRef(false);
  useEffect(() => {
    if (!session) {
      autoRedirectDoneRef.current = false;
      return;
    }
    if (autoRedirectDoneRef.current) return;
    autoRedirectDoneRef.current = true;
    const isAdmin = session.user.isSysadmin || session.user.tenantRoles.some((r) => r.role === 'admin');
    if (!isAdmin) return;
    api
      .doelenbomen(session.token)
      .then((items) => {
        if (items.length === 0) setView((prev) => (prev.name === 'picker' ? { name: 'tenants' } : prev));
      })
      .catch(() => {});
  }, [session]);

  // 15-minuten-inactiviteitsbeveiliging (zie useActivityPing.ts) — dekt de
  // React-schermen zelf; tree.html (iframe) heeft z'n eigen, identieke logica.
  useActivityPing(session?.token ?? null);

  // Zolang de tab open is (ongeacht welk scherm) laten we elke minuut weten dat
  // deze sessie nog leeft — zie db/init.sql (sessions) en tenantWipe.ts. Sluit je
  // de browser zonder uit te loggen, dan stopt dit vanzelf en telt de sessie na de
  // (per tenant instelbare) timeout als "verlaten".
  useEffect(() => {
    if (!session) return;
    const token = session.token;
    api.heartbeat(token).catch(() => {});
    const interval = setInterval(() => {
      api.heartbeat(token).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [session]);

  if (!session) {
    let publicContent;
    if (publicView.name === 'signup') {
      publicContent = (
        <SubscriptionRequestPage
          onBack={() => setPublicView({ name: 'login' })}
          onSubmitted={(email) => setPublicView({ name: 'signup-done', email })}
        />
      );
    } else if (publicView.name === 'signup-done') {
      publicContent = (
        <SignupDoneNotice email={publicView.email} onBack={() => setPublicView({ name: 'login' })} />
      );
    } else if (publicView.name === 'about') {
      publicContent = <AboutPage onBack={() => setPublicView({ name: 'login' })} />;
    } else {
      publicContent = (
        <LoginPage
          notice={authNotice}
          onLoggedIn={(token, user) => setSession({ token, user })}
          onSignupRequest={() => setPublicView({ name: 'signup' })}
          onAboutRequest={() => setPublicView({ name: 'about' })}
        />
      );
    }
    return (
      <>
        <div style={pageStyle}>
          <AnnouncementBanner />
          <div style={contentAreaStyle}>{publicContent}</div>
        </div>
        <VersionFooter />
      </>
    );
  }

  // Afgedwongen wachtwoordwijziging: staat vóór alle andere views, blokkeert de
  // rest van de app volledig totdat het wachtwoord vervangen is (zie
  // db/init.sql: must_change_password, gezet door een sysadmin bij aanmaken/
  // resetten van dit account).
  if (session.user.mustChangePassword) {
    return (
      <div style={pageStyle}>
        <AnnouncementBanner />
        <div style={contentAreaStyle}>
          <ChangePasswordPage
            token={session.token}
            forced
            onDone={(user) => setSession({ ...session, user })}
          />
        </div>
      </div>
    );
  }

  function requestLogout() {
    setLoggingOut(true);
  }

  function finishLogout() {
    setLoggingOut(false);
    setSession(null);
    setDoelenboom(null);
    setView({ name: 'picker' });
  }

  let content;
  // 'tenants'/'accounts' staan expliciet vóór de doelenboom-fallback: beide
  // zijn vanuit de picker bereikbaar zonder dat er al een doelenboom
  // geselecteerd is, dus "!doelenboom" mag deze views niet overrulen (dat
  // gold alleen voor 'import'/'tree', die wél een geselecteerde doelenboom
  // nodig hebben).
  if (view.name === 'tenants') {
    content = <TenantManagementPage token={session.token} user={session.user} onBack={() => setView({ name: 'picker' })} />;
  } else if (view.name === 'templates') {
    content = <DoelenboomTemplatesPage token={session.token} onBack={() => setView({ name: 'picker' })} />;
  } else if (view.name === 'subscription-requests') {
    content = <SubscriptionRequestsPage token={session.token} onBack={() => setView({ name: 'picker' })} />;
  } else if (view.name === 'accounts') {
    content = <AccountManagementPage token={session.token} user={session.user} onBack={() => setView({ name: 'picker' })} />;
  } else if (view.name === 'licenses') {
    content = <LicenseCatalogPage token={session.token} onBack={() => setView({ name: 'picker' })} />;
  } else if (view.name === 'help') {
    const returnView: View = view.from === 'tree' ? { name: 'tree' } : { name: 'picker' };
    content = <HelpPage onBack={() => setView(returnView)} />;
  } else if (view.name === 'password') {
    content = (
      <ChangePasswordPage
        token={session.token}
        forced={false}
        onDone={(user) => {
          setSession({ ...session, user });
          setView({ name: 'picker' });
        }}
        onCancel={() => setView({ name: 'picker' })}
      />
    );
  } else if (view.name === 'picker' || !doelenboom) {
    content = (
      <PickerPage
        token={session.token}
        user={session.user}
        onSelect={(d) => {
          setDoelenboom(d);
          setView({ name: 'tree' });
        }}
        onLogoutRequest={requestLogout}
        onTenantsRequest={() => setView({ name: 'tenants' })}
        onTemplatesRequest={() => setView({ name: 'templates' })}
        onSubscriptionRequestsRequest={() => setView({ name: 'subscription-requests' })}
        onAccountsRequest={() => setView({ name: 'accounts' })}
        onLicensesRequest={() => setView({ name: 'licenses' })}
        onHelpRequest={() => setView({ name: 'help', from: 'picker' })}
        onChangePasswordRequest={() => setView({ name: 'password' })}
      />
    );
  } else if (view.name === 'import') {
    content = (
      <ImportPage
        token={session.token}
        doelenboom={doelenboom}
        onBack={() => setView({ name: 'tree' })}
      />
    );
  } else {
    content = (
      <TreePage
        token={session.token}
        user={session.user}
        doelenboom={doelenboom}
        onBack={() => setView({ name: 'picker' })}
        onImport={() => setView({ name: 'import' })}
        onLogoutRequest={requestLogout}
        onHelpRequest={() => setView({ name: 'help', from: 'tree' })}
      />
    );
  }

  return (
    <>
      <div style={pageStyle}>
        <AnnouncementBanner />
        <PendingSubscriptionsBanner
          token={session.token}
          user={session.user}
          onOpenRequests={() => setView({ name: 'subscription-requests' })}
        />
        <div style={contentAreaStyle}>{content}</div>
      </div>
      {loggingOut && (
        <LogoutFlow token={session.token} onDone={finishLogout} onCancel={() => setLoggingOut(false)} />
      )}
      <VersionFooter />
    </>
  );
}

// Bevestiging na een geslaagde abonnementsaanvraag (zie SubscriptionRequestPage) —
// simpel bericht, geen eigen route: de proefaccount is er al, alleen inloggen
// hoeft nog.
function SignupDoneNotice({ email, onBack }: { email: string; onBack: () => void }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#eef1f8', fontFamily: 'system-ui, sans-serif', padding: '1rem' }}>
      <div style={{ background: 'white', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.1)', padding: '2rem', maxWidth: 420, textAlign: 'center' }}>
        <h1 style={{ color: '#203864', margin: '0 0 10px' }}>Aanvraag ontvangen</h1>
        <p style={{ color: '#444', fontSize: 14.5, lineHeight: 1.5 }}>
          Je proefaccount staat klaar. Log in met <strong>{email}</strong> en het wachtwoord dat je net gekozen hebt
          om meteen te beginnen — je hebt 14 dagen om de betaling te regelen.
        </p>
        <button
          onClick={onBack}
          style={{ marginTop: 12, padding: '0.6rem 1.2rem', borderRadius: 6, border: 'none', background: '#2F5597', color: 'white', fontSize: 14, cursor: 'pointer' }}
        >
          Naar inloggen
        </button>
      </div>
    </div>
  );
}

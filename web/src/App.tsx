import { useEffect, useState } from 'react';
import LoginPage from './pages/LoginPage';
import PickerPage from './pages/PickerPage';
import TreePage from './pages/TreePage';
import ImportPage from './pages/ImportPage';
import TenantManagementPage from './pages/TenantManagementPage';
import AccountManagementPage from './pages/AccountManagementPage';
import LicenseCatalogPage from './pages/LicenseCatalogPage';
import ChangePasswordPage from './pages/ChangePasswordPage';
import HelpPage from './pages/HelpPage';
import LogoutFlow from './components/LogoutFlow';
import VersionFooter from './components/VersionFooter';
import AnnouncementBanner from './components/AnnouncementBanner';
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
  | { name: 'accounts' }
  | { name: 'licenses' }
  | { name: 'password' }
  // 'from' onthoudt vanaf welk scherm Help geopend is (picker of tree), zodat
  // "Terug" daar weer naartoe kan — Help is vanuit beide bereikbaar.
  | { name: 'help'; from: 'picker' | 'tree' };

const HEARTBEAT_INTERVAL_MS = 60_000;

export default function App() {
  const { session, setSession } = useSession();
  const [doelenboom, setDoelenboom] = useState<DoelenboomSummary | null>(null);
  const [view, setView] = useState<View>({ name: 'picker' });
  // Losse overlay-state i.p.v. in PickerPage: zo kan "Uitloggen" ook vanuit de
  // boomweergave (tree.html, via postMessage) dezelfde flow starten, ongeacht
  // welk scherm er op dat moment getoond wordt.
  const [loggingOut, setLoggingOut] = useState(false);
  // Eénmalig (bij eerste render) uitgelezen én meteen gewist — een sessionStorage-
  // "boodschap voor de volgende load", niet iets dat blijvend in state hoort te
  // hangen (anders zou 'ie bij een latere, ongerelateerde 401 blijven staan).
  const [authNotice] = useState<string | null>(() => {
    const notice = sessionStorage.getItem(AUTH_NOTICE_KEY);
    if (notice) sessionStorage.removeItem(AUTH_NOTICE_KEY);
    return notice;
  });

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
    return (
      <>
        <AnnouncementBanner />
        <LoginPage notice={authNotice} onLoggedIn={(token, user) => setSession({ token, user })} />
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
      <>
        <AnnouncementBanner />
        <ChangePasswordPage
          token={session.token}
          forced
          onDone={(user) => setSession({ ...session, user })}
        />
      </>
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
      <AnnouncementBanner />
      {content}
      {loggingOut && (
        <LogoutFlow token={session.token} onDone={finishLogout} onCancel={() => setLoggingOut(false)} />
      )}
      <VersionFooter />
    </>
  );
}

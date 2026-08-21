import { useEffect, useState } from 'react';
import LoginPage from './pages/LoginPage';
import PickerPage from './pages/PickerPage';
import TreePage from './pages/TreePage';
import ImportPage from './pages/ImportPage';
import UserManagementPage from './pages/UserManagementPage';
import ChangePasswordPage from './pages/ChangePasswordPage';
import LogoutFlow from './components/LogoutFlow';
import VersionFooter from './components/VersionFooter';
import { api } from './api';
import { useSession } from './useSession';
import type { DoelenboomSummary } from './types';

type View = { name: 'picker' } | { name: 'tree' } | { name: 'import' } | { name: 'users' } | { name: 'password' };

const HEARTBEAT_INTERVAL_MS = 60_000;

export default function App() {
  const { session, setSession } = useSession();
  const [doelenboom, setDoelenboom] = useState<DoelenboomSummary | null>(null);
  const [view, setView] = useState<View>({ name: 'picker' });
  // Losse overlay-state i.p.v. in PickerPage: zo kan "Uitloggen" ook vanuit de
  // boomweergave (tree.html, via postMessage) dezelfde flow starten, ongeacht
  // welk scherm er op dat moment getoond wordt.
  const [loggingOut, setLoggingOut] = useState(false);

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
        <LoginPage onLoggedIn={(token, user) => setSession({ token, user })} />
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
      <ChangePasswordPage
        token={session.token}
        forced
        onDone={(user) => setSession({ ...session, user })}
      />
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
  // 'users' staat expliciet vóór de doelenboom-fallback: Gebruikersbeheer is
  // vanuit de picker bereikbaar zonder dat er al een doelenboom geselecteerd
  // is, dus "!doelenboom" mag deze view niet overrulen (dat gold alleen voor
  // 'import'/'tree', die wél een geselecteerde doelenboom nodig hebben).
  if (view.name === 'users') {
    content = <UserManagementPage token={session.token} user={session.user} onBack={() => setView({ name: 'picker' })} />;
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
        onUsersRequest={() => setView({ name: 'users' })}
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
      />
    );
  }

  return (
    <>
      {content}
      {loggingOut && (
        <LogoutFlow token={session.token} onDone={finishLogout} onCancel={() => setLoggingOut(false)} />
      )}
      <VersionFooter />
    </>
  );
}

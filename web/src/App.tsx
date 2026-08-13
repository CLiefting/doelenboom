import { useEffect, useState } from 'react';
import LoginPage from './pages/LoginPage';
import PickerPage from './pages/PickerPage';
import TreePage from './pages/TreePage';
import ImportPage from './pages/ImportPage';
import UserManagementPage from './pages/UserManagementPage';
import LogoutFlow from './components/LogoutFlow';
import { api } from './api';
import type { DoelenboomSummary, User } from './types';

type Session = { token: string; user: User };
type View = { name: 'picker' } | { name: 'tree' } | { name: 'import' } | { name: 'users' };

const STORAGE_KEY = 'doelenboom.session';
const HEARTBEAT_INTERVAL_MS = 60_000;

export default function App() {
  const [session, setSession] = useState<Session | null>(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  });
  const [doelenboom, setDoelenboom] = useState<DoelenboomSummary | null>(null);
  const [view, setView] = useState<View>({ name: 'picker' });
  // Losse overlay-state i.p.v. in PickerPage: zo kan "Uitloggen" ook vanuit de
  // boomweergave (tree.html, via postMessage) dezelfde flow starten, ongeacht
  // welk scherm er op dat moment getoond wordt.
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  }, [session]);

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
    return <LoginPage onLoggedIn={(token, user) => setSession({ token, user })} />;
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
  if (view.name === 'picker' || !doelenboom) {
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
      />
    );
  } else if (view.name === 'users') {
    content = <UserManagementPage token={session.token} user={session.user} onBack={() => setView({ name: 'picker' })} />;
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
    </>
  );
}

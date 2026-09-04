import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import DbStatPage from './pages/DbStatPage';
import SessionsPage from './pages/SessionsPage';
import AuditLogPage from './pages/AuditLogPage';
import SystemInfoPage from './pages/SystemInfoPage';

// Geen routerbibliotheek — dit zijn de enige losse URL's naast de hoofdapp, dus
// een simpele pathname-check volstaat. Vite's devserver (en de manier waarop dit
// via docker compose draait) valt voor onbekende paden terug op index.html, dus
// /dbstat, /sessions, /audit-log en /system-info laden gewoon dit bundle en
// kiezen hier hun eigen component.
const ROUTES: Record<string, typeof App> = {
  '/dbstat': DbStatPage,
  '/sessions': SessionsPage,
  '/audit-log': AuditLogPage,
  '/system-info': SystemInfoPage,
};
const Root = ROUTES[window.location.pathname] ?? App;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);

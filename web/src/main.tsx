import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import DbStatPage from './pages/DbStatPage';

// Geen routerbibliotheek — dit is de enige losse URL naast de hoofdapp, dus een
// simpele pathname-check volstaat. Vite's devserver (en de manier waarop dit
// via docker compose draait) valt voor onbekende paden terug op index.html, dus
// /dbstat laadt gewoon dit bundle en kiest hier zijn eigen component.
const Root = window.location.pathname === '/dbstat' ? DbStatPage : App;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);

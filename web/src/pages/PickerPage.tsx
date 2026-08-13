import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { DoelenboomSummary, User } from '../types';

export default function PickerPage({
  token,
  user,
  onSelect,
  onLogoutRequest,
  onUsersRequest,
  onChangePasswordRequest,
}: {
  token: string;
  user: User;
  onSelect: (d: DoelenboomSummary) => void;
  onLogoutRequest: () => void;
  onUsersRequest: () => void;
  onChangePasswordRequest: () => void;
}) {
  const canManageUsers = user.isSysadmin || user.tenantRoles.some((r) => r.role === 'admin');
  const [items, setItems] = useState<DoelenboomSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .doelenbomen(token)
      .then(setItems)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Kon doelenbomen niet laden'));
  }, [token]);

  const grouped = new Map<string, DoelenboomSummary[]>();
  for (const d of items ?? []) {
    const list = grouped.get(d.tenant_name) ?? [];
    list.push(d);
    grouped.set(d.tenant_name, list);
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 780, margin: '0 auto' }}>
      <header style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <h1 style={{ margin: 0, color: '#203864' }}>Doelenboom</h1>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <span style={{ fontSize: 13, color: '#9aa0a8', marginRight: 4 }}>{user.email}</span>
            {canManageUsers && (
              <button onClick={onUsersRequest} style={navLinkStyle()}>
                Gebruikersbeheer
              </button>
            )}
            {user.isSysadmin && (
              <a href="/dbstat" style={navLinkStyle()}>
                DB-status
              </a>
            )}
            <button onClick={onChangePasswordRequest} style={navLinkStyle()}>
              Wachtwoord wijzigen
            </button>
            <button onClick={onLogoutRequest} style={navLinkStyle('danger')}>
              Uitloggen
            </button>
          </div>
        </div>
      </header>

      {error && <p style={{ color: '#DC3545' }}>{error}</p>}
      {!items && !error && <p>Laden…</p>}
      {items && items.length === 0 && <p>Nog geen doelenbomen beschikbaar.</p>}

      {[...grouped.entries()].map(([tenantName, list]) => (
        <section key={tenantName} style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: 0.5, color: '#6c6f76' }}>{tenantName}</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {list.map((d) => (
              <button
                key={d.id}
                onClick={() => onSelect(d)}
                style={{
                  textAlign: 'left',
                  padding: '1rem',
                  borderRadius: 8,
                  border: '1px solid #d0d4da',
                  background: 'white',
                  cursor: 'pointer',
                  fontSize: 15,
                }}
              >
                <strong>{d.name}</strong>
                <div style={{ fontSize: 12, color: '#6c6f76' }}>{d.slug}</div>
              </button>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}

// Gedeelde stijl voor alle acties in de header (zowel <button> als <a>, vandaar
// geen border/background-reset via een CSS-class maar gewoon dezelfde inline
// stijl) — een pil met zichtbare rand i.p.v. losse onderstreepte tekstlinks,
// zodat ze er als groep bij elkaar horen en niet raar afbreken bij weinig ruimte.
function navLinkStyle(kind: 'default' | 'danger' = 'default'): React.CSSProperties {
  return {
    display: 'inline-block',
    padding: '5px 12px',
    borderRadius: 999,
    border: '1px solid #e4e6ea',
    background: '#f7f8fa',
    color: kind === 'danger' ? '#DC3545' : '#2F5597',
    fontSize: 13,
    fontWeight: 500,
    textDecoration: 'none',
    cursor: 'pointer',
  };
}

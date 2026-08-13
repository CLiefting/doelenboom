import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { DoelenboomSummary, User } from '../types';

export default function PickerPage({
  token,
  user,
  onSelect,
  onLogoutRequest,
  onUsersRequest,
}: {
  token: string;
  user: User;
  onSelect: (d: DoelenboomSummary) => void;
  onLogoutRequest: () => void;
  onUsersRequest: () => void;
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
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 720, margin: '0 auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0, color: '#203864' }}>Doelenboom</h1>
        <div style={{ fontSize: 14, color: '#6c6f76' }}>
          {user.email}
          {canManageUsers && (
            <button onClick={onUsersRequest} style={{ marginLeft: 12, border: 'none', background: 'none', color: '#2F5597', cursor: 'pointer' }}>
              Gebruikersbeheer
            </button>
          )}
          <button onClick={onLogoutRequest} style={{ marginLeft: 12, border: 'none', background: 'none', color: '#2F5597', cursor: 'pointer' }}>
            Uitloggen
          </button>
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

import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { DoelenboomSummary, User } from '../types';

export default function PickerPage({
  token,
  user,
  onSelect,
  onLogoutRequest,
  onTenantsRequest,
  onAccountsRequest,
  onLicensesRequest,
  onHelpRequest,
  onChangePasswordRequest,
}: {
  token: string;
  user: User;
  onSelect: (d: DoelenboomSummary) => void;
  onLogoutRequest: () => void;
  onTenantsRequest: () => void;
  onAccountsRequest: () => void;
  onLicensesRequest: () => void;
  onHelpRequest: () => void;
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
    <div style={styles.page}>
      <main style={styles.main}>
        <header style={styles.header}>
          <h1 style={styles.h1}>Doelenboom</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {canManageUsers && (
              <button onClick={onTenantsRequest} style={pillStyle()}>
                Tenantbeheer
              </button>
            )}
            <button onClick={onHelpRequest} style={styles.helpButton} title="Help" aria-label="Help">
              ?
            </button>
            <UserMenu
              user={user}
              onAccountsRequest={onAccountsRequest}
              onLicensesRequest={onLicensesRequest}
              onChangePasswordRequest={onChangePasswordRequest}
              onLogoutRequest={onLogoutRequest}
            />
          </div>
        </header>

        {error && <p style={{ color: '#DC3545' }}>{error}</p>}
        {!items && !error && <p style={styles.muted}>Laden…</p>}
        {items && items.length === 0 && <p style={styles.muted}>Nog geen doelenbomen beschikbaar.</p>}

        {[...grouped.entries()].map(([tenantName, list]) => (
          <section key={tenantName} style={styles.tenantSection}>
            <h2 style={styles.tenantHeading}>{tenantName}</h2>
            <div style={styles.cardGrid}>
              {list.map((d) => (
                <button
                  key={d.id}
                  onClick={() => onSelect(d)}
                  style={styles.card}
                  onMouseEnter={(e) => Object.assign(e.currentTarget.style, styles.cardHover)}
                  onMouseLeave={(e) => Object.assign(e.currentTarget.style, styles.card)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <strong style={styles.cardTitle}>{d.name}</strong>
                    {d.read_only && <span style={styles.badge}>alleen-lezen</span>}
                  </div>
                  <div style={styles.cardSlug}>{d.slug}</div>
                </button>
              ))}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}

// Alle account-brede acties (los van tenants/doelenbomen) zitten achter dit
// menu — houdt de header rustig zolang het aantal acties groeit (DB-status/
// Login-overzicht zijn bv. alleen voor sysadmins zichtbaar). "Tenantbeheer"
// blijft er bewust buiten: dat is de meest gebruikte actie voor een
// tenant-admin en verdient een eigen, direct zichtbare knop.
function UserMenu({
  user,
  onAccountsRequest,
  onLicensesRequest,
  onChangePasswordRequest,
  onLogoutRequest,
}: {
  user: User;
  onAccountsRequest: () => void;
  onLicensesRequest: () => void;
  onChangePasswordRequest: () => void;
  onLogoutRequest: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  const initial = user.email.trim().charAt(0).toUpperCase() || '?';

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={styles.userMenuButton}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span style={styles.avatar}>{initial}</span>
        <span style={styles.userMenuEmail}>{user.email}</span>
        <span style={{ ...styles.chevron, transform: open ? 'rotate(180deg)' : 'none' }}>▾</span>
      </button>

      {open && (
        <div style={styles.dropdown} role="menu">
          {user.isSysadmin && (
            <button
              role="menuitem"
              style={styles.dropdownItem}
              onClick={() => {
                setOpen(false);
                onAccountsRequest();
              }}
            >
              Accountbeheer
            </button>
          )}
          {user.isSysadmin && (
            <button
              role="menuitem"
              style={styles.dropdownItem}
              onClick={() => {
                setOpen(false);
                onLicensesRequest();
              }}
            >
              Licentiebeheer
            </button>
          )}
          {user.isSysadmin && (
            <a role="menuitem" href="/dbstat" style={styles.dropdownItem}>
              DB-status
            </a>
          )}
          {user.isSysadmin && (
            <a role="menuitem" href="/sessions" style={styles.dropdownItem}>
              Login-overzicht
            </a>
          )}
          {user.isSysadmin && <div style={styles.dropdownDivider} />}
          <button
            role="menuitem"
            style={styles.dropdownItem}
            onClick={() => {
              setOpen(false);
              onChangePasswordRequest();
            }}
          >
            Wachtwoord wijzigen
          </button>
          <div style={styles.dropdownDivider} />
          <button
            role="menuitem"
            style={{ ...styles.dropdownItem, color: '#DC3545' }}
            onClick={() => {
              setOpen(false);
              onLogoutRequest();
            }}
          >
            Uitloggen
          </button>
        </div>
      )}
    </div>
  );
}

function pillStyle(): React.CSSProperties {
  return {
    display: 'inline-block',
    padding: '7px 14px',
    borderRadius: 999,
    border: '1px solid #d7ddf0',
    background: 'white',
    color: '#2F5597',
    fontSize: 13.5,
    fontWeight: 600,
    textDecoration: 'none',
    cursor: 'pointer',
  };
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', background: '#f4f5f8' },
  main: { fontFamily: 'system-ui, sans-serif', padding: 'clamp(1.25rem, 4vw, 2.5rem)', maxWidth: 860, margin: '0 auto' },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12,
    marginBottom: '2.25rem',
  },
  h1: { margin: 0, color: '#203864', fontSize: 30, letterSpacing: -0.5 },
  muted: { color: '#9aa0a8', fontSize: 14 },

  helpButton: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 32, height: 32, borderRadius: '50%',
    border: '1px solid #e4e6ea', background: 'white', color: '#2F5597',
    fontSize: 14, fontWeight: 700, cursor: 'pointer', flexShrink: 0,
  },

  userMenuButton: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '5px 12px 5px 6px', borderRadius: 999,
    border: '1px solid #e4e6ea', background: 'white', cursor: 'pointer',
  },
  avatar: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 26, height: 26, borderRadius: '50%',
    background: '#2F5597', color: 'white', fontSize: 12.5, fontWeight: 700,
    flexShrink: 0,
  },
  userMenuEmail: { fontSize: 13, color: '#444', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  chevron: { fontSize: 11, color: '#9aa0a8', transition: 'transform 0.15s ease' },

  dropdown: {
    position: 'absolute', right: 0, top: 'calc(100% + 8px)', zIndex: 20,
    minWidth: 210, background: 'white', borderRadius: 10, border: '1px solid #e4e6ea',
    boxShadow: '0 8px 24px rgba(20, 30, 60, 0.12)', padding: 6,
    display: 'flex', flexDirection: 'column', gap: 2,
  },
  dropdownItem: {
    display: 'block', textAlign: 'left', width: '100%',
    padding: '8px 10px', borderRadius: 6, border: 'none', background: 'none',
    color: '#2F5597', fontSize: 13.5, fontWeight: 500, cursor: 'pointer', textDecoration: 'none',
    boxSizing: 'border-box',
  },
  dropdownDivider: { height: 1, background: '#f0f1f3', margin: '4px 2px' },

  tenantSection: { marginBottom: '1.75rem' },
  tenantHeading: {
    fontSize: 12.5, textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: 700,
    color: '#8b91a0', margin: '0 0 10px',
  },
  cardGrid: { display: 'flex', flexDirection: 'column', gap: 10 },
  card: {
    textAlign: 'left', padding: '1rem 1.1rem', borderRadius: 12,
    border: '1px solid #e4e6ea', background: 'white', cursor: 'pointer',
    fontSize: 15, boxShadow: '0 1px 2px rgba(20, 30, 60, 0.04)',
    transition: 'box-shadow 0.15s ease, transform 0.15s ease, border-color 0.15s ease',
  },
  cardHover: {
    textAlign: 'left', padding: '1rem 1.1rem', borderRadius: 12,
    border: '1px solid #c3cdea', background: 'white', cursor: 'pointer',
    fontSize: 15, boxShadow: '0 6px 16px rgba(20, 30, 60, 0.1)', transform: 'translateY(-1px)',
    transition: 'box-shadow 0.15s ease, transform 0.15s ease, border-color 0.15s ease',
  },
  cardTitle: { color: '#203864', fontSize: 15.5 },
  cardSlug: { fontSize: 12.5, color: '#9aa0a8', marginTop: 3 },
  badge: {
    fontSize: 11, color: '#946200', background: '#FFF3CD',
    border: '1px solid #FFE69C', borderRadius: 999, padding: '2px 8px',
  },
};

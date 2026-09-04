import { useState } from 'react';
import { api, ApiError } from '../api';
import type { User } from '../types';

// Zelfbedieningsscherm "Mijn beveiliging" — zie doelenboom_mfa_ontwerp.md §6.
// Voor sysadmins, én voor leden van een tenant met MFA verplicht
// (user.mfaRequiredTenants, zie tenants.mfa_required/TenantManagementPage.tsx),
// toont dit alleen de (niet-uitzetbare) verplichte status: MFA is voor hen
// sowieso vereist bij elke login (zie mfaRequired in api/src/auth.ts),
// onafhankelijk van deze eigen mfaEnabled-vlag. Voor iedereen anders is dit
// een simpele aan/uit-schakelaar.
export default function MySecurityPage({
  token,
  user,
  onDone,
  onCancel,
}: {
  token: string;
  user: User;
  onDone: (user: User) => void;
  onCancel: () => void;
}) {
  const [mfaEnabled, setMfaEnabled] = useState(user.mfaEnabled);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mfaRequiredByTenant = user.mfaRequiredTenants.length > 0;

  async function toggle() {
    if (user.isSysadmin || mfaRequiredByTenant) return;
    setError(null);
    setBusy(true);
    const next = !mfaEnabled;
    try {
      await api.updateMyMfaSetting(token, next);
      setMfaEnabled(next);
      onDone({ ...user, mfaEnabled: next });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Bijwerken mislukt.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={styles.main}>
      <div style={styles.card}>
        <h1 style={styles.title}>Mijn beveiliging</h1>
        <p style={styles.subtitle}>
          Tweestapsverificatie (MFA): bij inloggen sturen we, naast je wachtwoord, een tijdelijke code naar{' '}
          {user.email}.
        </p>

        {user.isSysadmin ? (
          <div style={styles.mandatoryBox}>
            <strong>Verplicht voor sysadmin-accounts.</strong>
            <span style={{ color: '#6c6f76' }}>
              Als sysadmin kun je dit niet zelf uitzetten. Kom je niet meer bij je code (bv. geen toegang meer tot
              je e-mail), neem dan contact op met een andere sysadmin.
            </span>
          </div>
        ) : mfaRequiredByTenant ? (
          <div style={styles.mandatoryBox}>
            <strong>
              Verplicht gesteld door {user.mfaRequiredTenants.length === 1 ? 'tenant' : 'de tenants'}{' '}
              "{user.mfaRequiredTenants.join('", "')}".
            </strong>
            <span style={{ color: '#6c6f76' }}>
              Je kunt dit niet zelf uitzetten. Kom je niet meer bij je code (bv. geen toegang meer tot je
              e-mail), neem dan contact op met een tenant- of sysadmin.
            </span>
          </div>
        ) : (
          <label style={styles.toggleRow}>
            <input type="checkbox" checked={mfaEnabled} disabled={busy} onChange={toggle} style={styles.checkbox} />
            <span>
              <div style={{ fontWeight: 600 }}>Tweestapsverificatie {mfaEnabled ? 'aan' : 'uit'}</div>
              <div style={{ color: '#6c6f76', fontSize: 13 }}>
                {mfaEnabled
                  ? 'Bij elke login vragen we een code die we naar je e-mailadres sturen.'
                  : 'Je logt in met alleen je wachtwoord.'}
              </div>
            </span>
          </label>
        )}

        {error && <p style={styles.error}>{error}</p>}

        <div style={{ display: 'flex', marginTop: '0.5rem' }}>
          <button type="button" onClick={onCancel} style={styles.ghostButton} disabled={busy}>
            Terug
          </button>
        </div>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    background: '#f4f5f7',
    fontFamily: 'system-ui, sans-serif',
    padding: '1rem',
    boxSizing: 'border-box',
  },
  card: {
    background: 'white',
    padding: 'clamp(1.5rem, 6vw, 2.5rem)',
    borderRadius: 12,
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    width: 'min(420px, 90vw)',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  title: { margin: 0, color: '#203864' },
  subtitle: { margin: '0 0 0.5rem', color: '#6c6f76', fontSize: 13.5, lineHeight: 1.4 },
  toggleRow: {
    display: 'flex', gap: 10, alignItems: 'flex-start',
    border: '1px solid #d0d4da', borderRadius: 8, padding: '0.75rem', cursor: 'pointer',
  },
  checkbox: { marginTop: 3, width: 18, height: 18, flexShrink: 0 },
  mandatoryBox: {
    display: 'flex', flexDirection: 'column', gap: 4,
    border: '1px solid #d0d4da', borderRadius: 8, padding: '0.75rem', fontSize: 13.5, color: '#203864',
  },
  ghostButton: {
    padding: '0.6rem 1rem',
    borderRadius: 6,
    border: '1px solid #d0d4da',
    background: 'white',
    color: '#444',
    fontSize: 14,
    cursor: 'pointer',
  },
  error: { color: '#DC3545', fontSize: 13, margin: 0 },
};

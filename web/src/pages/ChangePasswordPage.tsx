import { FormEvent, useState } from 'react';
import { api, ApiError } from '../api';
import type { User } from '../types';

// Twee ingangen naar hetzelfde scherm:
// - forced=true: App.tsx rendert dit i.p.v. de rest van de app zolang
//   user.mustChangePassword true is (een sysadmin heeft het account net
//   aangemaakt of het wachtwoord gereset) — geen "Annuleren", moet eerst.
// - forced=false: zelfbediening, oproepbaar via een knop naast "Uitloggen" op
//   het overzichtsscherm, met "Annuleren".
export default function ChangePasswordPage({
  token,
  forced,
  onDone,
  onCancel,
}: {
  token: string;
  forced: boolean;
  onDone: (user: User) => void;
  onCancel?: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 8) {
      setError('Nieuw wachtwoord moet minstens 8 tekens zijn.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Nieuw wachtwoord en bevestiging komen niet overeen.');
      return;
    }
    setBusy(true);
    try {
      const { user } = await api.changePassword(token, currentPassword, newPassword);
      onDone(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Wachtwoord wijzigen mislukt.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={styles.main}>
      <form onSubmit={handleSubmit} style={styles.card}>
        <h1 style={styles.title}>Wachtwoord wijzigen</h1>
        <p style={styles.subtitle}>
          {forced
            ? 'Je account is net aangemaakt (of het wachtwoord is gereset) — kies eerst een eigen wachtwoord voordat je verdergaat.'
            : 'Wijzig je wachtwoord.'}
        </p>
        <label style={styles.label}>
          Huidig wachtwoord
          <input
            style={styles.input}
            type="password"
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoFocus
          />
        </label>
        <label style={styles.label}>
          Nieuw wachtwoord
          <input
            style={styles.input}
            type="password"
            required
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </label>
        <label style={styles.label}>
          Bevestig nieuw wachtwoord
          <input
            style={styles.input}
            type="password"
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </label>
        {error && <p style={styles.error}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: '0.5rem' }}>
          {!forced && onCancel && (
            <button type="button" onClick={onCancel} style={styles.ghostButton} disabled={busy}>
              Annuleren
            </button>
          )}
          <button style={styles.button} type="submit" disabled={busy}>
            {busy ? 'Bezig…' : 'Wachtwoord wijzigen'}
          </button>
        </div>
      </form>
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
  },
  card: {
    background: 'white',
    padding: '2.5rem',
    borderRadius: 12,
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    width: 340,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  title: { margin: 0, color: '#203864' },
  subtitle: { margin: '0 0 0.5rem', color: '#6c6f76', fontSize: 13.5, lineHeight: 1.4 },
  label: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14, color: '#333' },
  input: { padding: '0.5rem', borderRadius: 6, border: '1px solid #d0d4da', fontSize: 14 },
  button: {
    flex: 1,
    marginTop: '0.5rem',
    padding: '0.6rem',
    borderRadius: 6,
    border: 'none',
    background: '#2F5597',
    color: 'white',
    fontSize: 14,
    cursor: 'pointer',
  },
  ghostButton: {
    marginTop: '0.5rem',
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

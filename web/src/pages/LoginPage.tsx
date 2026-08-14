import { FormEvent, useState } from 'react';
import { api, ApiError } from '../api';
import type { User } from '../types';

export default function LoginPage({ onLoggedIn }: { onLoggedIn: (token: string, user: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { token, user } = await api.login(email, password);
      onLoggedIn(token, user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Inloggen mislukt');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={styles.main}>
      <form onSubmit={handleSubmit} style={styles.card}>
        <h1 style={styles.title}>Doelenboom</h1>
        <p style={styles.subtitle}>Log in om verder te gaan.</p>
        <label style={styles.label}>
          E-mail
          <input
            style={styles.input}
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
        </label>
        <label style={styles.label}>
          Wachtwoord
          <input
            style={styles.input}
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p style={styles.error}>{error}</p>}
        <button style={styles.button} type="submit" disabled={busy}>
          {busy ? 'Bezig…' : 'Inloggen'}
        </button>
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
    padding: 'clamp(1.5rem, 6vw, 2.5rem)',
    borderRadius: 12,
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    width: 'min(320px, 90vw)',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  title: { margin: 0, color: '#203864' },
  subtitle: { margin: '0 0 0.5rem', color: '#6c6f76', fontSize: 14 },
  label: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14, color: '#333' },
  // fontSize 16px i.p.v. 14px: onder de 16px zoomt mobiel Safari automatisch in
  // zodra je op een invoerveld tikt — bewust gelijk aan het label om niet uit de
  // toon te vallen.
  input: { padding: '0.5rem', borderRadius: 6, border: '1px solid #d0d4da', fontSize: 16 },
  button: {
    marginTop: '0.5rem',
    padding: '0.6rem',
    borderRadius: 6,
    border: 'none',
    background: '#2F5597',
    color: 'white',
    fontSize: 14,
    cursor: 'pointer',
  },
  error: { color: '#DC3545', fontSize: 13, margin: 0 },
};

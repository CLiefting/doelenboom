import { useState } from 'react';
import { api, ApiError } from '../api';
import LegalPage from '../pages/LegalPage';
import type { User } from '../types';

// Blokkerend acceptatiescherm voor de gebruiksvoorwaarden — mirrort exact het
// bestaande mustChangePassword-patroon in App.tsx (afgedwongen wachtwoord-
// wijziging): staat vóór de rest van de app totdat er expliciet is
// geaccepteerd. Getoond wanneer session.user.termsAcceptanceRequired true is
// (zie api/src/legal.ts needsTermsAcceptance) — dus bij eerste gebruik, of na
// publicatie van een nieuwe versie met requires_reacceptance = true (§6 van de
// opdracht).
//
// Vinkje staat bewust NOOIT vooraf aangevinkt (§4 van de opdracht), en
// "Gebruiksvoorwaarden" in de labeltekst is zelf een klikbare link naar de
// volledige tekst (LegalPage, hieronder inline getoond i.p.v. te navigeren —
// zodat de acceptatiecontext niet verloren gaat). De daadwerkelijke
// acceptatie wordt server-side geregistreerd op basis van het token
// (POST /api/legal/terms/accept, zie routes/legal.ts) — nooit vertrouwd op
// enkel deze checkbox-state in de browser.
export default function TermsAcceptanceGate({
  token,
  user,
  onDone,
}: {
  token: string;
  user: User;
  onDone: (user: User) => void;
}) {
  const [checked, setChecked] = useState(false);
  const [showFullText, setShowFullText] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (showFullText) {
    return <LegalPage type="terms" onBack={() => setShowFullText(false)} />;
  }

  async function handleAccept() {
    setError(null);
    if (!checked) {
      setError('Vink aan dat je akkoord gaat om verder te gaan.');
      return;
    }
    setBusy(true);
    try {
      // acceptCurrentTerms (server) registreert de acceptatie op basis van het
      // token — de respons hier is puur bevestiging (versie), geen volledig
      // user-object. We weten dat de blokkade nu vervalt (needsTermsAcceptance
      // zou hierna false teruggeven), dus die ene vlag lokaal bijwerken volstaat
      // i.p.v. opnieuw /me op te vragen.
      await api.acceptTerms(token);
      onDone({ ...user, termsAcceptanceRequired: false });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Accepteren is mislukt.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={styles.main}>
      <div style={styles.card}>
        <h1 style={styles.title}>Gebruiksvoorwaarden</h1>
        <p style={styles.subtitle}>
          Voordat je verdergaat, vragen we je akkoord te gaan met de geldende gebruiksvoorwaarden.
        </p>
        <label style={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            style={styles.checkbox}
          />
          <span>
            Ik ga akkoord met de{' '}
            <button type="button" onClick={() => setShowFullText(true)} style={styles.link}>
              Gebruiksvoorwaarden
            </button>
          </span>
        </label>
        {error && <p style={styles.error}>{error}</p>}
        <button style={styles.button} onClick={handleAccept} disabled={busy}>
          {busy ? 'Bezig…' : 'Akkoord en doorgaan'}
        </button>
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
  },
  card: {
    background: 'white',
    padding: 'clamp(1.5rem, 6vw, 2.5rem)',
    borderRadius: 12,
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    width: 'min(400px, 92vw)',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.9rem',
  },
  title: { margin: 0, color: '#203864' },
  subtitle: { margin: 0, color: '#6c6f76', fontSize: 13.5, lineHeight: 1.5 },
  checkboxRow: { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 14, color: '#333', lineHeight: 1.5 },
  checkbox: { marginTop: 3 },
  link: {
    background: 'none', border: 'none', padding: 0, margin: 0, cursor: 'pointer',
    color: '#2F5597', fontWeight: 600, fontSize: 14, textDecoration: 'underline',
  },
  button: {
    marginTop: '0.25rem', padding: '0.6rem', borderRadius: 6, border: 'none',
    background: '#2F5597', color: 'white', fontSize: 14, cursor: 'pointer',
  },
  error: { color: '#DC3545', fontSize: 13, margin: 0 },
};

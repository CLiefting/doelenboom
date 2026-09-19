import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';

// Bevestigingspagina voor de link in de verificatiemail (DOEL-20):
// /aanvraag/bevestigen#<token>. Het token staat bewust in het URL-fragment: dat
// gaat niet mee naar de server, dus het komt niet in nginx-/proxy-logs of
// Referer-headers terecht. We lezen het één keer en halen het meteen uit de
// adresbalk. Het account wordt pas aangemaakt na een klik op de knop — zo
// verbruikt een mailscanner of link-preview die de pagina alleen "bekijkt" de
// eenmalige link niet.
type State =
  | { name: 'ready' }
  | { name: 'busy' }
  | { name: 'done' }
  | { name: 'error'; message: string }
  | { name: 'missing' };

function errMsg(err: unknown): string {
  if (err instanceof ApiError || err instanceof Error) return err.message;
  return 'Er ging iets mis. Probeer het later opnieuw.';
}

export default function SubscriptionConfirmPage() {
  const [token, setToken] = useState<string>('');
  const [state, setState] = useState<State>({ name: 'ready' });

  useEffect(() => {
    const t = window.location.hash.replace(/^#/, '').trim();
    if (!t) {
      setState({ name: 'missing' });
      return;
    }
    setToken(t);
    // Token niet in de adresbalk/geschiedenis laten staan.
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  async function confirm() {
    setState({ name: 'busy' });
    try {
      await api.confirmSubscriptionRequest(token);
      setToken('');
      setState({ name: 'done' });
    } catch (err) {
      setState({ name: 'error', message: errMsg(err) });
    }
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <h1 style={styles.h1}>Aanvraag bevestigen</h1>
        {state.name === 'missing' && (
          <p style={styles.p}>
            Deze pagina is bedoeld voor de bevestigingslink uit je e-mail. Open de link uit de mail opnieuw, of vraag je
            abonnement opnieuw aan.
          </p>
        )}
        {(state.name === 'ready' || state.name === 'busy') && (
          <>
            <p style={styles.p}>Klik op de knop om je aanvraag te bevestigen en je proefaccount te activeren.</p>
            <button onClick={confirm} disabled={state.name === 'busy'} style={styles.button}>
              {state.name === 'busy' ? 'Bezig…' : 'Bevestig mijn aanvraag'}
            </button>
          </>
        )}
        {state.name === 'done' && (
          <>
            <p style={styles.p}>
              Bedankt! Je proefaccount is geactiveerd. Log in met je e-mailadres en het wachtwoord dat je bij de aanvraag
              gekozen hebt — je hebt 14 dagen om de betaling te regelen.
            </p>
            <a href="/" style={{ ...styles.button, display: 'inline-block', textDecoration: 'none' }}>
              Naar inloggen
            </a>
          </>
        )}
        {state.name === 'error' && (
          <>
            <p style={{ ...styles.p, color: '#a12' }} role="alert">{state.message}</p>
            <a href="/" style={styles.link}>Terug naar de startpagina</a>
          </>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#eef1f8', fontFamily: 'system-ui, sans-serif', padding: '1rem' },
  card: { background: 'white', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.1)', padding: '2rem', maxWidth: 420, textAlign: 'center' },
  h1: { color: '#203864', margin: '0 0 10px' },
  p: { color: '#444', fontSize: 14.5, lineHeight: 1.5 },
  button: { marginTop: 12, padding: '0.6rem 1.2rem', borderRadius: 6, border: 'none', background: '#2F5597', color: 'white', fontSize: 14, cursor: 'pointer' },
  link: { color: '#2F5597', fontSize: 14 },
};

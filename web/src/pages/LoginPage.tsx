import { FormEvent, useState } from 'react';
import { api, ApiError } from '../api';
import type { User } from '../types';

// Kort, feitelijk overzicht van wat dit platform doet — puur ter oriëntatie
// voor iemand die het inlogscherm ziet, geen marketingclaims. Bewust een
// vaste lijst (geen API-call): dit zijn platform-brede features, geen data
// die per tenant verschilt.
const FEATURES: { icon: JSX.Element; title: string; description: string }[] = [
  {
    icon: <TreeIcon />,
    title: 'Interactieve boomweergave',
    description:
      'Zoek, filter op tag of organisatieonderdeel, en volg met één klik het volledige pad van project tot missie.',
  },
  {
    icon: <ExcelIcon />,
    title: 'Excel in en uit',
    description:
      'Upload een referentietabel, bekijk het validatierapport en publiceer pas na controle — of exporteer de huidige data terug als Excel.',
  },
  {
    icon: <ColumnsIcon />,
    title: 'Configureerbare kolommen',
    description:
      'Elke doelenboom bepaalt zijn eigen kolomtypes en -namen — niet vastgezet op één vaste structuur.',
  },
  {
    icon: <UsersIcon />,
    title: 'Multi-tenant met rollen',
    description:
      'Meerdere organisaties, elk met eigen doelenbomen en leden, met rechten van alleen-lezen tot volledig beheer.',
  },
];

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
    <div style={styles.page}>
      {/* Media query kan niet via inline styles — dit stukje CSS verbergt het
          features-paneel op smalle schermen (telefoon/smalle tablet), zodat
          daar alleen het inlogformulier overblijft. */}
      <style>{`
        @media (max-width: 860px) {
          .login-features-panel { display: none !important; }
          .login-form-panel { flex: 1 1 100% !important; }
        }
      `}</style>

      <div className="login-features-panel" style={styles.featuresPanel}>
        <div style={styles.featuresPanelInner}>
          <div>
            <div style={styles.brandRow}>
              <span style={styles.brandMark}>D</span>
              <span style={styles.brandName}>Doelenboom</span>
            </div>
            <p style={styles.tagline}>
              Eén platform om de doelenboom van jouw organisatie te beheren, te delen en actueel te houden.
            </p>
          </div>

          <ul style={styles.featureList}>
            {FEATURES.map((f) => (
              <li key={f.title} style={styles.featureItem}>
                <span style={styles.featureIcon}>{f.icon}</span>
                <span>
                  <div style={styles.featureTitle}>{f.title}</div>
                  <div style={styles.featureDescription}>{f.description}</div>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="login-form-panel" style={styles.formPanel}>
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
      </div>
    </div>
  );
}

function iconProps() {
  return { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'white', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
}

function TreeIcon() {
  return (
    <svg {...iconProps()}>
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="12" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="12" r="2.2" />
      <path d="M8.2 5h3a2 2 0 0 1 2 2v3M8.2 12h5M8.2 19h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

function ExcelIcon() {
  return (
    <svg {...iconProps()}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
      <path d="M8 8l8 8M16 8l-8 8" />
    </svg>
  );
}

function ColumnsIcon() {
  return (
    <svg {...iconProps()}>
      <rect x="3.5" y="4" width="4.5" height="16" rx="1" />
      <rect x="9.75" y="4" width="4.5" height="16" rx="1" />
      <rect x="16" y="4" width="4.5" height="16" rx="1" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg {...iconProps()}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19.5c0-3 2.5-5.5 5.5-5.5s5.5 2.5 5.5 5.5" />
      <circle cx="17.5" cy="8.5" r="2.3" />
      <path d="M15.2 14.2c2.6.4 4.3 2.5 4.3 5.3" />
    </svg>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: 'flex',
    minHeight: '100vh',
    fontFamily: 'system-ui, sans-serif',
  },
  featuresPanel: {
    flex: '1 1 50%',
    background: 'linear-gradient(160deg, #203864 0%, #2F5597 100%)',
    display: 'flex',
    alignItems: 'center',
    padding: 'clamp(2rem, 5vw, 4rem)',
    boxSizing: 'border-box',
  },
  featuresPanelInner: {
    maxWidth: 460,
    marginLeft: 'auto',
    marginRight: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '2.5rem',
  },
  brandRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 },
  brandMark: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 34, height: 34, borderRadius: 9, background: 'rgba(255,255,255,0.16)',
    color: 'white', fontWeight: 700, fontSize: 17,
  },
  brandName: { color: 'white', fontWeight: 700, fontSize: 19, letterSpacing: -0.3 },
  tagline: { color: 'rgba(255,255,255,0.82)', fontSize: 15.5, lineHeight: 1.55, margin: 0 },
  featureList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '1.3rem' },
  featureItem: { display: 'flex', gap: 14, alignItems: 'flex-start' },
  featureIcon: {
    flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 38, height: 38, borderRadius: 10, background: 'rgba(255,255,255,0.14)',
  },
  featureTitle: { color: 'white', fontWeight: 600, fontSize: 14.5, marginBottom: 3 },
  featureDescription: { color: 'rgba(255,255,255,0.72)', fontSize: 13.5, lineHeight: 1.5 },

  formPanel: {
    flex: '1 1 50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f4f5f7',
    padding: '2rem',
    boxSizing: 'border-box',
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

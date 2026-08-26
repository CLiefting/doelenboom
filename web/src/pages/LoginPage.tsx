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

// notice: reden waarom iemand (mogelijk) automatisch teruggezet is op dit
// scherm — 'idle_timeout' (15-minuten-inactiviteitsbeveiliging, zie
// useActivityPing.ts/api.ts) of 'session_ended' (elders uitgelogd, of de
// sessie is serverside beëindigd). null/undefined = gewoon een normale
// bezoek aan het inlogscherm, geen melding nodig.
export default function LoginPage({
  onLoggedIn,
  notice,
}: {
  onLoggedIn: (token: string, user: User) => void;
  notice?: string | null;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const noticeText =
    notice === 'idle_timeout'
      ? 'Je bent automatisch uitgelogd wegens 15 minuten inactiviteit (beveiliging).'
      : notice === 'session_ended'
      ? 'Je sessie is beëindigd. Log opnieuw in om verder te gaan.'
      : null;

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
          daar alleen het inlogformulier overblijft. De hero-tile blijft altijd
          zichtbaar, ook op mobiel. */}
      <style>{`
        @media (max-width: 860px) {
          .login-features-panel { display: none !important; }
          .login-form-panel { flex: 1 1 100% !important; }
        }
      `}</style>

      {/* Eye-catcher, los van de twee kolommen hieronder — zodat de kernboodschap
          meteen opvalt, boven de vouw, ongeacht schermbreedte. */}
      <div style={styles.heroBand}>
        <div style={styles.heroTile}>
          <div style={styles.brandRow}>
            <span style={styles.brandMark}>D</span>
            <span style={styles.brandName}>Doelenboom</span>
          </div>
          <h1 style={styles.heroHeadline}>Van ambitie naar aantoonbare waarde</h1>
          <p style={styles.heroSubline}>Inzicht in samenhang. Sturen op waarde. Aantoonbaar resultaat.</p>
        </div>
      </div>

      <div style={styles.split}>
      <div className="login-features-panel" style={styles.featuresPanel}>
        <div style={styles.featuresPanelInner}>
          <div>
            <p style={styles.tagline}>
              Doelenboom maakt zichtbaar hoe alles wat een organisatie doet, bijdraagt aan wat zij wil bereiken.
            </p>
            <p style={styles.tagline}>
              Door strategie, baten, capabilities, projecten en resultaten met elkaar te verbinden ontstaat één
              heldere lijn van investering naar impact.
            </p>
            <p style={styles.tagline}>
              Zo zie je niet alleen wat de organisatie doet, maar vooral waarom, waaraan het bijdraagt en of het
              daadwerkelijk waarde oplevert.
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
          {noticeText && <p style={styles.notice}>{noticeText}</p>}
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
  // Lichte achtergrondkleur op paginaniveau (i.p.v. alleen op de heroBand) —
  // zo blijft er overal een randje van deze kleur zichtbaar rond de losse,
  // afgeronde vlakken hieronder (hero-tile, features-paneel, formulier),
  // i.p.v. dat het features-paneel randloos tegen de vensterrand aan plakt.
  page: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100vh',
    fontFamily: 'system-ui, sans-serif',
    background: '#eef1f8',
  },
  heroBand: {
    display: 'flex', justifyContent: 'center',
    // Kleinere minimumwaarde dan voorheen (was 1.5rem vast): op een smalle
    // telefoon (<400px) telt anders elke geneste padding-laag hieronder op
    // tot te weinig overblijft voor de inhoud.
    padding: 'clamp(1rem, 4vw, 2.5rem) clamp(1rem, 4vw, 2.5rem) 0',
  },
  heroTile: {
    width: '100%', maxWidth: 780, textAlign: 'center',
    background: 'linear-gradient(135deg, #203864 0%, #2F5597 100%)',
    borderRadius: 16, padding: 'clamp(1.25rem, 4vw, 2.25rem) clamp(1rem, 5vw, 3rem)',
    boxShadow: '0 12px 32px rgba(32, 56, 100, 0.25)',
    boxSizing: 'border-box',
  },
  heroHeadline: {
    color: 'white', fontWeight: 800, fontSize: 'clamp(1.5rem, 3.6vw, 2.2rem)',
    lineHeight: 1.2, letterSpacing: -0.5, margin: '4px 0 10px',
  },
  heroSubline: {
    color: 'rgba(255,255,255,0.88)', fontWeight: 600, fontSize: 14.5,
    letterSpacing: 0.2, margin: 0,
  },
  split: {
    display: 'flex', flex: 1,
    gap: 'clamp(1rem, 3vw, 1.5rem)',
    padding: 'clamp(1rem, 3vw, 1.5rem) clamp(1rem, 4vw, 2.5rem) clamp(1rem, 4vw, 2.5rem)',
  },
  featuresPanel: {
    flex: '1 1 50%',
    background: 'linear-gradient(160deg, #203864 0%, #2F5597 100%)',
    display: 'flex',
    alignItems: 'center',
    padding: 'clamp(2rem, 5vw, 4rem)',
    boxSizing: 'border-box',
    borderRadius: 16,
    boxShadow: '0 8px 24px rgba(32, 56, 100, 0.18)',
    // Deze kolom heeft nu genoeg tekst om op een laag scherm hoger te worden
    // dan de beschikbare hoogte — dan liever intern scrollen dan clippen of
    // de layout breken.
    overflowY: 'auto',
  },
  featuresPanelInner: {
    maxWidth: 460,
    marginLeft: 'auto',
    marginRight: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '2rem',
  },
  brandRow: { display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center', marginBottom: 4 },
  brandMark: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 30, height: 30, borderRadius: 8, background: 'rgba(255,255,255,0.16)',
    color: 'white', fontWeight: 700, fontSize: 15,
  },
  brandName: { color: 'white', fontWeight: 700, fontSize: 16, letterSpacing: -0.3 },
  tagline: { color: 'rgba(255,255,255,0.82)', fontSize: 15, lineHeight: 1.55, margin: '0 0 10px' },
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
    // clamp i.p.v. een vaste 2rem: op een smalle telefoon telt dit op bij de
    // padding van .split hierboven, en at een vaste 2rem (32px) aan beide
    // kanten bleef er te weinig breedte over voor de kaart eronder.
    padding: 'clamp(1rem, 5vw, 2rem)',
    boxSizing: 'border-box',
    borderRadius: 16,
  },
  card: {
    background: 'white',
    padding: 'clamp(1.25rem, 6vw, 2.5rem)',
    borderRadius: 12,
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    // 100% (i.p.v. de eerdere 'min(320px, 90vw)') schaalt mee met de écht
    // beschikbare breedte van het ouder-element — vw-eenheden kijken naar de
    // volledige viewport en negeren de padding van .split/.formPanel
    // hierboven, wat op smalle telefoons tot horizontale overflow leidde.
    width: '100%',
    maxWidth: 320,
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
  notice: {
    color: '#664d03', background: '#FFF3CD', border: '1px solid #FFE69C',
    borderRadius: 6, padding: '0.5rem 0.65rem', fontSize: 13, margin: 0,
  },
};

import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { LegalDocument } from '../types';

// Publieke pagina voor de volledige gebruiksvoorwaarden of privacyverklaring
// (GET /api/legal/:type, zie api/src/routes/legal.ts) — bereikbaar zonder in
// te loggen (§2/§19 van de opdracht: geen juridisch document weggestopt in
// een klein scrollend modal, altijd een eigen pagina). TermsAcceptanceGate.tsx
// gebruikt dit component voor de "Lees de volledige tekst"-link.
//
// content volgt een lichte, zelfbedachte Markdown-achtige conventie
// (opgebouwd bij het overzetten van het bronbestand, zie
// db/migrations/0017_legal_and_retention.sql): '## ' = paragraafkop (H2),
// '### ' = subkop (H3), '- ' = opsommingsitem, een lege regel scheidt
// alinea's, al het overige is platte alinea-tekst. Bewust een handgeschreven
// regel-voor-regel renderer i.p.v. een markdown-library erbij te halen — de
// conventie is klein en vast, een hele dependency zou overkill zijn.
function renderContent(content: string) {
  const lines = content.split('\n');
  const blocks: JSX.Element[] = [];
  let paragraphLines: string[] = [];
  let listItems: string[] = [];

  function flushParagraph() {
    if (paragraphLines.length === 0) return;
    blocks.push(
      <p key={`p-${blocks.length}`} style={styles.p}>
        {paragraphLines.join(' ')}
      </p>
    );
    paragraphLines = [];
  }

  function flushList() {
    if (listItems.length === 0) return;
    blocks.push(
      <ul key={`ul-${blocks.length}`} style={styles.ul}>
        {listItems.map((item, i) => (
          <li key={i} style={styles.li}>{item}</li>
        ))}
      </ul>
    );
    listItems = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith('## ')) {
      flushParagraph();
      flushList();
      blocks.push(<h2 key={`h2-${blocks.length}`} style={styles.h2}>{line.slice(3)}</h2>);
    } else if (line.startsWith('### ')) {
      flushParagraph();
      flushList();
      blocks.push(<h3 key={`h3-${blocks.length}`} style={styles.h3}>{line.slice(4)}</h3>);
    } else if (line.startsWith('- ')) {
      flushParagraph();
      listItems.push(line.slice(2));
    } else if (line.trim() === '') {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraphLines.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

export default function LegalPage({
  type,
  onBack,
}: {
  type: 'terms' | 'privacy';
  onBack: () => void;
}) {
  const [doc, setDoc] = useState<LegalDocument | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDoc(null);
    setError(null);
    api
      .legalDocument(type)
      .then(setDoc)
      .catch((err) => {
        setError(err instanceof ApiError && err.status === 404 ? 'Dit document is nog niet beschikbaar.' : 'Kon het document niet laden.');
      });
  }, [type]);

  const title = type === 'terms' ? 'Gebruiksvoorwaarden' : 'Privacyverklaring';

  return (
    <div style={styles.page}>
      <main style={styles.main}>
        <button onClick={onBack} style={styles.backBtn}>← Terug</button>

        <h1 style={styles.h1}>{title}</h1>

        {doc && doc.status !== 'published' && (
          <div style={styles.conceptBanner}>
            {type === 'privacy'
              ? 'Concept — de definitieve privacyverklaring is nog niet vastgesteld. Deze tekst is een placeholder en dient nog inhoudelijk te worden opgesteld en beoordeeld.'
              : 'Concept — deze versie is nog niet als definitief gepubliceerd en dient nog juridisch te worden getoetst.'}
          </div>
        )}

        {doc && (
          <div style={styles.metaRow}>
            <span>Versie {doc.version}</span>
            <span>·</span>
            <span>Ingangsdatum {doc.effectiveDate}</span>
          </div>
        )}

        {error && <p style={styles.p}>{error}</p>}
        {!doc && !error && <p style={styles.p}>Laden…</p>}
        {doc && <div style={styles.body}>{renderContent(doc.content)}</div>}
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { display: 'flex', flexDirection: 'column', minHeight: '100vh', fontFamily: 'system-ui, sans-serif', background: '#eef1f8' },
  main: { maxWidth: 760, margin: '0 auto', width: '100%', padding: 'clamp(1rem, 3vw, 2rem) clamp(1rem, 4vw, 2.5rem) clamp(2rem, 5vw, 3.5rem)', boxSizing: 'border-box' },
  backBtn: {
    borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: '1.5px solid #d0d4da', background: 'white', color: '#444', marginBottom: '1.25rem',
  },
  h1: { fontSize: 'clamp(1.4rem, 3vw, 1.9rem)', color: '#203864', margin: '0 0 8px', letterSpacing: -0.4 },
  metaRow: { display: 'flex', gap: 8, fontSize: 12.5, color: '#6c6f76', marginBottom: '1.25rem' },
  conceptBanner: {
    background: '#fff4e5', border: '1px solid #f0c987', color: '#8a5a10',
    borderRadius: 8, padding: '10px 14px', fontSize: 13.5, lineHeight: 1.5, marginBottom: '1.25rem', fontWeight: 600,
  },
  body: {
    background: 'white', borderRadius: 12, border: '1px solid #e4e6ea',
    padding: 'clamp(1.25rem, 3vw, 2rem)',
  },
  h2: { fontSize: 17, color: '#203864', margin: '22px 0 8px' },
  h3: { fontSize: 14.5, color: '#2F5597', margin: '14px 0 6px' },
  p: { fontSize: 14, lineHeight: 1.65, color: '#333', margin: '0 0 10px', maxWidth: '68ch' },
  ul: { margin: '0 0 10px', paddingLeft: 22 },
  li: { fontSize: 14, lineHeight: 1.65, color: '#333', marginBottom: 4, maxWidth: '64ch' },
};

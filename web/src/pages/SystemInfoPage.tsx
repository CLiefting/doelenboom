import { useEffect, useMemo, useState } from 'react';
import LoginPage from './LoginPage';
import { api, ApiError } from '../api';
import { useSession } from '../useSession';
import type {
  ApplicationComponentKey,
  DependencyComponentRow,
  DependencyEcosystem,
  DependencyHealthSummaryResponse,
  DependencyScope,
  DependencyType,
  DependencyVulnerabilityRow,
  SeverityLevel,
  UpdateCategory,
} from '../types';

// Losse route (/system-info, zie main.tsx) — zelfde opzet als DbStatPage/
// SessionsPage/AuditLogPage: eigen login via useSession, alleen sysadmins
// mogen verder. Toont de Softwarecomponenten-pagina (Beheer → Systeem-
// informatie → Softwarecomponenten): SBOM-overzicht, alle componenten van
// de drie Doelenboom-onderdelen (api/web/excel-service) met update-status,
// en bekende kwetsbaarheden — zie doelenboom_sbom_ontwerp.md in het project
// en api/src/dependencyHealth.ts voor de achterliggende service. Bewust GEEN
// automatische dependency-upgrades vanuit de app zelf — alleen signaleren.
export default function SystemInfoPage() {
  const { session, setSession } = useSession();

  if (!session) {
    return <LoginPage onLoggedIn={(token, user) => setSession({ token, user })} />;
  }
  if (!session.user.isSysadmin) {
    return (
      <main style={styles.main}>
        <div style={styles.card}>
          <h1 style={styles.title}>Geen toegang</h1>
          <p style={{ color: '#6c6f76', fontSize: 14 }}>
            /system-info is alleen voor sysadmins. Je bent ingelogd als {session.user.email}.
          </p>
          <a href="/" style={styles.link}>← Terug naar Doelenboom</a>
        </div>
      </main>
    );
  }
  return <SystemInfoContent token={session.token} />;
}

const APPLICATION_COMPONENT_LABELS: Record<ApplicationComponentKey, string> = {
  api: 'api (backend)',
  web: 'web (frontend)',
  'excel-service': 'excel-service (backend)',
};

const UPDATE_CATEGORY_LABELS: Record<UpdateCategory, string> = {
  actueel: 'Actueel',
  patch: 'Patch-update beschikbaar',
  minor: 'Minor-update beschikbaar',
  major: 'Major-update beschikbaar',
  onbekend: 'Onbekend',
};

const UPDATE_CATEGORY_COLORS: Record<UpdateCategory, { bg: string; fg: string; border: string }> = {
  actueel: { bg: '#E8F5E9', fg: '#2e7d32', border: '#C8E6C9' },
  patch: { bg: '#E3F2FD', fg: '#1565C0', border: '#BBDEFB' },
  minor: { bg: '#FFF3CD', fg: '#946200', border: '#FFE69C' },
  major: { bg: '#FDECEA', fg: '#C62828', border: '#F5C6CB' },
  onbekend: { bg: '#F1F2F4', fg: '#6c6f76', border: '#e4e6ea' },
};

const SEVERITY_LABELS: Record<SeverityLevel, string> = {
  kritiek: 'Kritiek',
  hoog: 'Hoog',
  gemiddeld: 'Gemiddeld',
  laag: 'Laag',
  onbekend: 'Onbekend',
};

const SEVERITY_COLORS: Record<SeverityLevel, { bg: string; fg: string; border: string }> = {
  kritiek: { bg: '#FDECEA', fg: '#C62828', border: '#F5C6CB' },
  hoog: { bg: '#FFF0E0', fg: '#B15C00', border: '#FFD9B3' },
  gemiddeld: { bg: '#FFF3CD', fg: '#946200', border: '#FFE69C' },
  laag: { bg: '#E3F2FD', fg: '#1565C0', border: '#BBDEFB' },
  onbekend: { bg: '#F1F2F4', fg: '#6c6f76', border: '#e4e6ea' },
};

const DEPENDENCY_TYPE_LABELS: Record<DependencyType, string> = {
  direct: 'Directe dependency',
  transitive: 'Transitieve dependency',
};

const SCOPE_LABELS: Record<DependencyScope, string> = {
  runtime: 'Runtime',
  development: 'Ontwikkeling',
};

function Badge({ label, colors }: { label: string; colors: { bg: string; fg: string; border: string } }) {
  return (
    <span
      style={{
        fontSize: 11.5, fontWeight: 600, color: colors.fg, background: colors.bg,
        border: `1px solid ${colors.border}`, borderRadius: 999, padding: '2px 9px', whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

function formatTimestamp(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('nl-NL');
}

type Tab = 'overzicht' | 'componenten' | 'kwetsbaarheden';

function SystemInfoContent({ token }: { token: string }) {
  const [tab, setTab] = useState<Tab>('overzicht');
  const [summary, setSummary] = useState<DependencyHealthSummaryResponse | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  function loadSummary() {
    setSummaryError(null);
    api.sbomSummary(token).then(setSummary).catch((err) => {
      setSummaryError(err instanceof ApiError ? err.message : 'Kon SBOM-overzicht niet laden.');
    });
  }

  useEffect(loadSummary, [token]);

  // Wordt zowel door de "Nu controleren"-knop hierboven als door de
  // gelijknamige knoppen in de Componenten-/Kwetsbaarhedentabs aangeroepen —
  // ververst steeds ook de samenvatting, zodat de tellingen bovenin
  // meteen kloppen.
  async function handleRefresh() {
    setRefreshNotice(null);
    setRefreshing(true);
    try {
      const result = await api.sbomRefresh(token);
      if (result.status === 'success') {
        setRefreshNotice(
          `Controle voltooid: ${result.componentsChecked} componenten gecontroleerd, ${result.vulnerabilitiesFound} kwetsbaarheden gevonden.`
        );
      } else {
        setRefreshNotice(`Controle afgerond met status "${result.status}"${result.error ? `: ${result.error}` : '.'}`);
      }
      loadSummary();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setRefreshNotice(err.message);
      } else if (err instanceof ApiError && err.status === 409) {
        setRefreshNotice(err.message);
      } else {
        setRefreshNotice(err instanceof ApiError ? err.message : 'Controle mislukt.');
      }
    } finally {
      setRefreshing(false);
    }
  }

  async function handleDownload() {
    setDownloadError(null);
    setDownloading(true);
    try {
      const { blob, filename } = await api.downloadSbom(token);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) {
      setDownloadError(err instanceof ApiError ? err.message : 'SBOM-download mislukt.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <main style={styles.mainWide}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={styles.title}>Softwarecomponenten</h1>
          <p style={{ color: '#6c6f76', fontSize: 13.5, margin: '4px 0 0' }}>
            SBOM (Software Bill of Materials) en update-/kwetsbaarhedencontrole voor alle Doelenboom-onderdelen — alleen
            signalering, Doelenboom werkt zelf nooit automatisch dependencies bij.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={handleRefresh} disabled={refreshing} style={styles.ghostButton}>
            {refreshing ? 'Bezig…' : '↻ Nu controleren'}
          </button>
          <button onClick={handleDownload} disabled={downloading} style={styles.ghostButton}>
            {downloading ? 'Bezig…' : '⬇ Download SBOM'}
          </button>
          <a href="/" style={{ ...styles.ghostButton, textDecoration: 'none', display: 'inline-block' }}>← Terug</a>
        </div>
      </header>

      {refreshNotice && <p style={{ fontSize: 13, color: '#203864', background: '#EEF2FA', border: '1px solid #D6E0F5', borderRadius: 8, padding: '8px 12px' }}>{refreshNotice}</p>}
      {downloadError && <p style={{ color: '#DC3545' }}>{downloadError}</p>}

      <nav style={styles.tabs}>
        <TabButton label="Overzicht" active={tab === 'overzicht'} onClick={() => setTab('overzicht')} />
        <TabButton label="Componenten" active={tab === 'componenten'} onClick={() => setTab('componenten')} />
        <TabButton label="Kwetsbaarheden" active={tab === 'kwetsbaarheden'} onClick={() => setTab('kwetsbaarheden')} />
      </nav>

      {summaryError && <p style={{ color: '#DC3545' }}>{summaryError}</p>}

      {tab === 'overzicht' && <OverzichtTab summary={summary} />}
      {tab === 'componenten' && <ComponentenTab token={token} />}
      {tab === 'kwetsbaarheden' && <KwetsbaarhedenTab token={token} />}
    </main>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={active ? styles.tabActive : styles.tab}>
      {label}
    </button>
  );
}

function OverzichtTab({ summary }: { summary: DependencyHealthSummaryResponse | null }) {
  if (!summary) return <p>Laden…</p>;
  if (!summary.available) {
    return (
      <section style={styles.section}>
        <p style={{ color: '#6c6f76', fontSize: 13.5 }}>
          Geen SBOM beschikbaar. Draai <code>scripts/generate-sbom.sh</code> (onderdeel van de build-pipeline, zie
          <code> scripts/pre-build.sh</code>) en klik daarna op "Nu controleren".
        </p>
      </section>
    );
  }

  const cards: Array<{ label: string; value: string | number; sub?: string }> = [
    { label: 'Bouwversie', value: summary.buildVersion ?? '—', sub: summary.gitCommit ? `commit ${summary.gitCommit}` : undefined },
    { label: 'SBOM gegenereerd op', value: formatTimestamp(summary.generatedAt) },
    { label: 'Laatst gecontroleerd op', value: formatTimestamp(summary.lastCheckedAt) },
    { label: 'Totaal aantal componenten', value: summary.totalComponents },
    { label: 'Directe dependencies', value: summary.directDependencies },
    { label: 'Transitieve dependencies', value: summary.transitiveDependencies },
    { label: 'Updates beschikbaar', value: summary.updatesAvailable },
    { label: 'Waarvan major-updates', value: summary.majorUpdates },
    { label: 'Componenten met kwetsbaarheden', value: summary.vulnerableComponents },
    { label: 'Waarvan kritieke kwetsbaarheden', value: summary.criticalVulnerabilities },
  ];

  return (
    <section style={styles.cardsGrid}>
      {cards.map((c) => (
        <div key={c.label} style={styles.statCard}>
          <div style={styles.statLabel}>{c.label}</div>
          <div style={styles.statValue}>{c.value}</div>
          {c.sub && <div style={styles.statSub}>{c.sub}</div>}
        </div>
      ))}
      {summary.cyclonedxSpecVersion && (
        <div style={{ ...styles.statCard, gridColumn: '1 / -1' }}>
          <div style={styles.statLabel}>CycloneDX-specificatie / SBOM-serienummer</div>
          <div style={{ ...styles.statValue, fontSize: 13, fontFamily: 'monospace' }}>
            {summary.cyclonedxSpecVersion} — {summary.sbomSerialNumber ?? '—'}
          </div>
        </div>
      )}
    </section>
  );
}

const PAGE_SIZE = 50;

function ComponentenTab({ token }: { token: string }) {
  const [items, setItems] = useState<DependencyComponentRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [applicationComponent, setApplicationComponent] = useState<ApplicationComponentKey | ''>('');
  const [ecosystem, setEcosystem] = useState<DependencyEcosystem | ''>('');
  const [dependencyType, setDependencyType] = useState<DependencyType | ''>('');
  const [scope, setScope] = useState<DependencyScope | ''>('');
  const [updateCategory, setUpdateCategory] = useState<UpdateCategory | ''>('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'applicationComponent' | 'updateCategory' | 'version'>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Zoeken debouncen (300ms) i.p.v. bij elke toetsaanslag een verzoek te
  // sturen — filters/sort/pagina resetten wél meteen, dat zijn losse
  // gebruikersacties, geen getypte tekst.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => setOffset(0), [applicationComponent, ecosystem, dependencyType, scope, updateCategory, search, sortBy, sortDir]);

  useEffect(() => {
    setError(null);
    api
      .sbomComponents(token, {
        applicationComponent: applicationComponent || undefined,
        ecosystem: ecosystem || undefined,
        dependencyType: dependencyType || undefined,
        scope: scope || undefined,
        updateCategory: updateCategory || undefined,
        search: search || undefined,
        sortBy,
        sortDir,
        limit: PAGE_SIZE,
        offset,
      })
      .then((res) => {
        setItems(res.items);
        setTotal(res.total);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : 'Kon componenten niet laden.');
      });
  }, [token, applicationComponent, ecosystem, dependencyType, scope, updateCategory, search, sortBy, sortDir, offset]);

  function toggleSort(field: typeof sortBy) {
    if (sortBy === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortDir('asc');
    }
  }

  return (
    <section>
      <div style={styles.filterBar}>
        <select value={applicationComponent} onChange={(e) => setApplicationComponent(e.target.value as ApplicationComponentKey | '')} style={styles.select}>
          <option value="">Alle onderdelen</option>
          {(Object.keys(APPLICATION_COMPONENT_LABELS) as ApplicationComponentKey[]).map((k) => (
            <option key={k} value={k}>{APPLICATION_COMPONENT_LABELS[k]}</option>
          ))}
        </select>
        <select value={ecosystem} onChange={(e) => setEcosystem(e.target.value as DependencyEcosystem | '')} style={styles.select}>
          <option value="">Alle ecosystemen</option>
          <option value="npm">npm</option>
          <option value="pypi">PyPI</option>
        </select>
        <select value={dependencyType} onChange={(e) => setDependencyType(e.target.value as DependencyType | '')} style={styles.select}>
          <option value="">Direct + transitief</option>
          <option value="direct">Directe dependency</option>
          <option value="transitive">Transitieve dependency</option>
        </select>
        <select value={scope} onChange={(e) => setScope(e.target.value as DependencyScope | '')} style={styles.select}>
          <option value="">Runtime + ontwikkeling</option>
          <option value="runtime">Runtime</option>
          <option value="development">Ontwikkeling</option>
        </select>
        <select value={updateCategory} onChange={(e) => setUpdateCategory(e.target.value as UpdateCategory | '')} style={styles.select}>
          <option value="">Alle update-statussen</option>
          {(Object.keys(UPDATE_CATEGORY_LABELS) as UpdateCategory[]).map((k) => (
            <option key={k} value={k}>{UPDATE_CATEGORY_LABELS[k]}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Zoek op naam…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          style={styles.searchInput}
        />
      </div>

      {error && <p style={{ color: '#DC3545' }}>{error}</p>}
      {!items && !error && <p>Laden…</p>}

      {items && (
        <>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <SortableTh label="Naam" field="name" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} />
                  <SortableTh label="Onderdeel" field="applicationComponent" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} />
                  <SortableTh label="Versie" field="version" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} />
                  <th style={styles.th}>Nieuwste versie</th>
                  <SortableTh label="Update-status" field="updateCategory" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} />
                  <th style={styles.th}>Type</th>
                  <th style={styles.th}>Scope</th>
                  <th style={styles.th}>Licentie</th>
                  <th style={styles.th}>Kwetsbaarheden</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && (
                  <tr><td style={styles.td} colSpan={9}>Geen componenten gevonden voor deze filters.</td></tr>
                )}
                {items.map((c) => (
                  <tr key={c.id}>
                    <td style={styles.td}>{c.name}</td>
                    <td style={styles.td}>{APPLICATION_COMPONENT_LABELS[c.applicationComponent]}</td>
                    <td style={styles.td}>{c.version}</td>
                    <td style={styles.td}>{c.latestVersion ?? '—'}</td>
                    <td style={styles.td}><Badge label={UPDATE_CATEGORY_LABELS[c.updateCategory]} colors={UPDATE_CATEGORY_COLORS[c.updateCategory]} /></td>
                    <td style={styles.td}>{DEPENDENCY_TYPE_LABELS[c.dependencyType]}</td>
                    <td style={styles.td}>{SCOPE_LABELS[c.scope]}</td>
                    <td style={styles.td}>{c.license ?? '—'}</td>
                    <td style={styles.td}>
                      {c.vulnerabilityCount > 0
                        ? <Badge label={`${c.vulnerabilityCount}`} colors={SEVERITY_COLORS.hoog} />
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination total={total} offset={offset} pageSize={PAGE_SIZE} onOffsetChange={setOffset} />
        </>
      )}
    </section>
  );
}

function KwetsbaarhedenTab({ token }: { token: string }) {
  const [items, setItems] = useState<DependencyVulnerabilityRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [applicationComponent, setApplicationComponent] = useState<ApplicationComponentKey | ''>('');
  const [severityLevel, setSeverityLevel] = useState<SeverityLevel | ''>('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => setOffset(0), [applicationComponent, severityLevel, search]);

  useEffect(() => {
    setError(null);
    api
      .sbomVulnerabilities(token, {
        applicationComponent: applicationComponent || undefined,
        severityLevel: severityLevel || undefined,
        search: search || undefined,
        limit: PAGE_SIZE,
        offset,
      })
      .then((res) => {
        setItems(res.items);
        setTotal(res.total);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : 'Kon kwetsbaarheden niet laden.');
      });
  }, [token, applicationComponent, severityLevel, search, offset]);

  return (
    <section>
      <div style={styles.filterBar}>
        <select value={applicationComponent} onChange={(e) => setApplicationComponent(e.target.value as ApplicationComponentKey | '')} style={styles.select}>
          <option value="">Alle onderdelen</option>
          {(Object.keys(APPLICATION_COMPONENT_LABELS) as ApplicationComponentKey[]).map((k) => (
            <option key={k} value={k}>{APPLICATION_COMPONENT_LABELS[k]}</option>
          ))}
        </select>
        <select value={severityLevel} onChange={(e) => setSeverityLevel(e.target.value as SeverityLevel | '')} style={styles.select}>
          <option value="">Alle ernst-niveaus</option>
          {(Object.keys(SEVERITY_LABELS) as SeverityLevel[]).map((k) => (
            <option key={k} value={k}>{SEVERITY_LABELS[k]}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Zoek op component/CVE/ID…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          style={styles.searchInput}
        />
      </div>

      {error && <p style={{ color: '#DC3545' }}>{error}</p>}
      {!items && !error && <p>Laden…</p>}

      {items && (
        <>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Component</th>
                  <th style={styles.th}>Versie</th>
                  <th style={styles.th}>Kwetsbaarheid-ID</th>
                  <th style={styles.th}>CVE</th>
                  <th style={styles.th}>Ernst</th>
                  <th style={styles.th}>Samenvatting</th>
                  <th style={styles.th}>Fix-versie</th>
                  <th style={styles.th}>Bron</th>
                  <th style={styles.th}>Gecontroleerd op</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && (
                  <tr><td style={styles.td} colSpan={9}>Geen kwetsbaarheden gevonden voor deze filters.</td></tr>
                )}
                {items.map((v) => (
                  <tr key={v.id}>
                    <td style={styles.td}>{v.componentName} <span style={{ opacity: 0.5, fontSize: 12 }}>({APPLICATION_COMPONENT_LABELS[v.applicationComponent]})</span></td>
                    <td style={styles.td}>{v.componentVersion}</td>
                    <td style={styles.td}>{v.vulnerabilityId}</td>
                    <td style={styles.td}>{v.cve ?? '—'}</td>
                    <td style={styles.td}><Badge label={SEVERITY_LABELS[v.severityLevel]} colors={SEVERITY_COLORS[v.severityLevel]} /></td>
                    <td style={{ ...styles.td, maxWidth: 320 }}>{v.summary ?? '—'}</td>
                    <td style={styles.td}>{v.fixedVersion ?? '—'}</td>
                    <td style={styles.td}>{v.source}</td>
                    <td style={styles.td}>{formatTimestamp(v.checkedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination total={total} offset={offset} pageSize={PAGE_SIZE} onOffsetChange={setOffset} />
        </>
      )}
    </section>
  );
}

function SortableTh({
  label, field, sortBy, sortDir, onClick,
}: {
  label: string; field: string; sortBy: string; sortDir: 'asc' | 'desc'; onClick: (field: any) => void;
}) {
  const active = sortBy === field;
  return (
    <th style={{ ...styles.th, cursor: 'pointer', userSelect: 'none' }} onClick={() => onClick(field)}>
      {label}{active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );
}

function Pagination({ total, offset, pageSize, onOffsetChange }: { total: number; offset: number; pageSize: number; onOffsetChange: (o: number) => void }) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + pageSize, total);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, fontSize: 13, color: '#6c6f76' }}>
      <span>{from}–{to} van {total}</span>
      <button style={styles.ghostButtonSmall} disabled={offset === 0} onClick={() => onOffsetChange(Math.max(0, offset - pageSize))}>← Vorige</button>
      <button style={styles.ghostButtonSmall} disabled={to >= total} onClick={() => onOffsetChange(offset + pageSize)}>Volgende →</button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh',
    background: '#f4f5f7', fontFamily: 'system-ui, sans-serif',
  },
  card: {
    background: 'white', padding: 'clamp(1.5rem, 6vw, 2.5rem)', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    width: 'min(380px, 90vw)', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '0.75rem',
  },
  mainWide: { fontFamily: 'system-ui, sans-serif', padding: 'clamp(1rem, 4vw, 2rem)', maxWidth: 1200, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 },
  title: { margin: 0, color: '#203864' },
  link: { color: '#2F5597', fontSize: 14 },
  section: { marginBottom: '1.5rem', background: 'white', borderRadius: 10, padding: '1.25rem 1.5rem', border: '1px solid #e4e6ea' },
  tabs: { display: 'flex', gap: 4, borderBottom: '1px solid #e4e6ea' },
  tab: {
    padding: '8px 16px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', color: '#6c6f76',
    background: 'transparent', border: 'none', borderBottom: '2px solid transparent',
  },
  tabActive: {
    padding: '8px 16px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', color: '#203864',
    background: 'transparent', border: 'none', borderBottom: '2px solid #2F5597',
  },
  cardsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 },
  statCard: { background: 'white', borderRadius: 10, padding: '1rem 1.1rem', border: '1px solid #e4e6ea' },
  statLabel: { fontSize: 12, color: '#6c6f76', marginBottom: 6 },
  statValue: { fontSize: 22, fontWeight: 700, color: '#203864' },
  statSub: { fontSize: 11.5, color: '#9aa0a8', marginTop: 4 },
  filterBar: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 },
  select: { fontSize: 13, padding: '6px 8px', borderRadius: 6, border: '1.5px solid #d0d4da', background: 'white', color: '#333' },
  searchInput: { fontSize: 13, padding: '6px 10px', borderRadius: 6, border: '1.5px solid #d0d4da', minWidth: 200, flexGrow: 1 },
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', borderBottom: '1px solid #e4e6ea', padding: '6px 8px', color: '#6c6f76', fontWeight: 600, whiteSpace: 'nowrap' },
  td: { borderBottom: '1px solid #f0f1f3', padding: '6px 8px' },
  ghostButton: {
    borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: '1.5px solid #d0d4da', background: 'white', color: '#444',
  },
  ghostButtonSmall: {
    borderRadius: 6, padding: '4px 10px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
    border: '1.5px solid #d0d4da', background: 'white', color: '#444',
  },
};

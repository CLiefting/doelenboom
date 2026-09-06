// "Over Doelenboom" — releasegeschiedenis, zichtbaar voor iedere ingelogde
// gebruiker (via het gebruikersmenu op de picker-pagina, PickerPage.tsx).
// Bewust een aparte pagina van AboutPage.tsx (de publieke, ongeauthenticeerde
// marketingpagina "Wat is een doelenboom?") en van HelpPage.tsx
// (featuredocumentatie, "hoe doe ik dit?") — deze pagina is puur "wat is er
// wanneer bijgekomen", voor gebruikers die de app al kennen. Statische
// content, geen API-calls — RELEASES hieronder wordt bij elke release met de
// hand bijgewerkt (zie ook het "wat is nieuw"-overzicht dat hiervoor als
// losse chatvraag is opgesteld).
type Release = {
  version: string;
  date: string; // Nederlandse notatie, bv. "6 september 2026"
  title: string;
  items: string[];
};

const RELEASES: Release[] = [
  {
    version: '1.7.0',
    date: '6 september 2026',
    title: 'Klantbeheer, klantnummer, abonnements-/module-opzegging',
    items: [
      'Nieuw scherm Klantbeheer: contactpersonen per klant (tenant-admin/CISO/overig, met wisselgeschiedenis van het primaire contact), klantgegevens (KvK/btw/factuuradres/tags/contractreferentie), klantgezondheid-indicator (gezond/aandacht/risico), verlengingsherinnering.',
      'Los klantnummer naast het technische klant-ID, vrij herschikbaar door sysadmins, uniek zodra gezet.',
      'Polis-model voor opzegging: hoofdabonnement én modules kunnen nu expliciet worden opgezegd — een verlopen einddatum zet pas op read-only ná opzegging, daarvoor blijft alles schrijfbaar (wel zichtbaar als "risico").',
      'Modules/opties krijgen een eigen start- en einddatum en zijn los op te zeggen.',
      'Contractstatus-veld (lopend/opgezegd/beëindigd) op de klant-eigen contractreferentie — puur informatief.',
    ],
  },
  {
    version: '1.6.1',
    date: '4 september 2026',
    title: 'Beveiligingsonderhoud',
    items: [
      '19 kwetsbaarheden in dependencies opgelost (gevonden via de Softwarecomponenten-pagina).',
      'Overige laag-risico dependency-updates.',
    ],
  },
  {
    version: '1.6.0',
    date: '4 september 2026',
    title: 'Auditlogboek, MFA, Softwarecomponenten',
    items: [
      'Auditlogboek: wie heeft wanneer wat gewijzigd (boombezoeken, tenant-instellingen), sysadmin-only.',
      'Tweestapsverificatie (MFA): verplicht voor sysadmins, optioneel voor overige gebruikers, en tenant-breed verplicht te zetten.',
      'Softwarecomponenten-pagina (SBOM) + kwetsbaarheidsmonitoring van dependencies.',
      'Beveiligingsfixes: JWT_SECRET fail-fast, formule-injectie in Excel-exports voorkomen, qs-kwetsbaarheid.',
    ],
  },
  {
    version: '1.5.1',
    date: '3 september 2026',
    title: 'Tenant hernoemen',
    items: ['Tenant hernoemen (naam + slug), sysadmin-only.'],
  },
  {
    version: '1.5.0',
    date: '3 september 2026',
    title: 'Back-ups en extra beveiliging',
    items: [
      'Nachtelijke volledige databaseback-up + aan/uit-schuif voor de Excel-back-up.',
      'Rate limiting / accountblokkade bij inloggen.',
      'Instelbare popup-melding bij het openen van een doelenboom.',
      'Beveiligingsheaders (helmet) + CORS beperkt tot bekende origins.',
    ],
  },
  {
    version: '1.4.2',
    date: '2 september 2026',
    title: 'PowerPoint-export, afhankelijkheden tussen deliverables',
    items: [
      'PPT-rapportage-knop op de projectkaart (incl. projecttijdlijn).',
      'Afhankelijkheden tussen deliverables/mijlpalen (type + vertraging), met waarschuwing bij planningsconflict.',
      'Nachtelijke reset van de hele demo-tenant + nieuwe demodata (Agile boom, Vergunningen).',
      "Excel-export: ontbrekende Activiteiten-tab en 'Hangt af van'-kolom toegevoegd.",
      'Kritieke bugfix: Excel-upload met waarschuwingen crashte de hele API.',
    ],
  },
  {
    version: '1.4.0',
    date: '31 augustus 2026',
    title: 'Wijzigingshistorie en kolomsamenvatting',
    items: [
      'Volledige wijzigingshistorie op projectstatus, deliverables en activiteiten (wie/wanneer/wat).',
      'Kolomsamenvatting: dubbelklik op kolomkop toont overzicht + HTML-export.',
      "'Laatst bijgewerkt' + 'verouderd'-markering op projecten.",
      'Chip-filters (tag/org/verouderd) direct vanuit de boomfilter.',
    ],
  },
  {
    version: '1.3.1',
    date: '31 augustus 2026',
    title: 'Juridisch, evaluatie-abonnement',
    items: [
      'Gebruiksvoorwaarden, privacyverklaring en automatische accountretentie.',
      'Gratis Evaluatie-abonnement (1 admin, 2 bomen, 30 dagen proef, alle modules aan).',
      'Sorteerbaar abonnementenoverzicht in Tenantbeheer + telefoonnummer bij aanvraag, direct bewerken en betaling/verlenging registreren.',
      'Verplichte check op actieve gebruikers vóór een productie-update.',
    ],
  },
  {
    version: '1.3.0',
    date: '30 augustus 2026',
    title: 'Zelfbedieningsaanvraag voor abonnementen',
    items: [
      'Zelfbedieningsaanvraag: nieuwe klant kiest zelf tier + modules, met proefperiode; sysadmin registreert betaling/verlenging/afwijzing.',
      'Prijsgeschiedenis voor tiers/modules i.p.v. één vast prijsveld.',
      'Doelenboom-sjablonen: nieuwe boom snel starten vanuit een sjabloon + beheerscherm.',
      'Open toegang per tenant (alle gebruikers automatisch lid met instelbare rol).',
      'Nachtelijke Excel-back-up van alle doelenbomen.',
      'Publieke uitlegpagina "Wat is een doelenboom?" + eye-catcher-screenshot op het inlogscherm.',
      'Help-pagina uitgebreid (rollen, hoe-doe-ik, projecten-module).',
    ],
  },
  {
    version: '1.2.0 / 1.2.1',
    date: '28 augustus 2026',
    title: 'Activiteitenplanning en Gantt',
    items: [
      'Activiteitenplanning (start-/einddatum) met Gantt-tijdlijn onder elk project.',
      'Afhankelijkheden tussen taken (Finish-Start e.a.), fase-taken in-/uitklapbaar.',
      'Import van taken uit MS Project (.xml/.mpp), incl. veilig herimporteren.',
      'Mijlpalen als ruit-icoon, deliverable-balkjes met verwachte én werkelijke datum als aparte markers.',
      'Rol "bezoeker" toegevoegd; sysadmin verliest automatische toegang tot boominhoud (privacy).',
      'Actieve-gebruikers-inzicht, 15-minuten-inactiviteitsbeveiliging, systeemmelding-banner.',
      'Excel-export/import voor projectgegevens (producten, activiteiten, status, tags, org-onderdelen).',
    ],
  },
  {
    version: '1.1.0',
    date: '25 augustus 2026',
    title: 'Bugfix',
    items: ['Testregressie door module-gating verholpen (geen zichtbare functiewijziging).'],
  },
  {
    version: '1.0.0 / 1.0.1',
    date: '23 augustus 2026',
    title: 'Eerste "1.0"',
    items: [
      'Inlogscherm: waardepropositie-tekst, geronde vlakken, mobiele layoutfix.',
      'Versienummer in de footer toont voortaan de release-tag i.p.v. alleen de commit-hash.',
    ],
  },
  {
    version: '0.9.0',
    date: '22 augustus 2026',
    title: 'Boomweergave-verfijningen',
    items: [
      'SVG-export van een gemarkeerd pad i.p.v. altijd de hele boom.',
      'Bouwrichting én kijkrichting/anker omkeerbaar in de boomweergave.',
      '"Terug naar vorig scherm" onthoudt het projecttijdlijnenoverzicht.',
    ],
  },
  {
    version: '0.8.0',
    date: '21 augustus 2026',
    title: 'Eerste gelogde release',
    items: [
      'Rol-override per doelenboom bovenop de tenant-rol.',
      'Planning-items (deliverables/mijlpalen) met tijdbalk in het projectpaneel.',
      'Overzicht "alle project-tijdlijnen".',
      'Boomweergave: focus/kolomweergave blijft behouden, tijdlijn met maand-/kwartaalvlakken, filters/legenda in dropdown.',
      'Versienummer zichtbaar in de footer; testsuite + regressiechecklist.',
    ],
  },
];

function releaseAnchor(version: string): string {
  return `release-${version.replace(/[^0-9.]/g, '').replace(/\./g, '-')}`;
}

export default function WhatsNewPage({ onBack }: { onBack: () => void }) {
  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Over Doelenboom</h1>
          <p style={styles.subtitle}>Releasegeschiedenis — wat er per versie is toegevoegd of gewijzigd.</p>
        </div>
        <button onClick={onBack} style={styles.backBtn}>← Terug</button>
      </header>

      <nav style={styles.toc} aria-label="Versies">
        {RELEASES.map((r) => (
          <a key={r.version} href={`#${releaseAnchor(r.version)}`} style={styles.tocLink}>
            v{r.version}
          </a>
        ))}
      </nav>

      {RELEASES.map((r) => (
        <section key={r.version} id={releaseAnchor(r.version)} style={styles.section}>
          <div style={styles.sectionHeader}>
            <span style={styles.versionBadge}>v{r.version}</span>
            <h2 style={styles.h2}>{r.title}</h2>
            <span style={styles.date}>{r.date}</span>
          </div>
          <ul style={styles.list}>
            {r.items.map((item, i) => (
              <li key={i} style={styles.listItem}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { fontFamily: 'system-ui, sans-serif', padding: 'clamp(1rem, 4vw, 2rem)', maxWidth: 760, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: '1.25rem' },
  title: { margin: 0, color: '#203864' },
  subtitle: { margin: '4px 0 0', color: '#6c6f76', fontSize: 13.5 },
  backBtn: {
    borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: '1.5px solid #d0d4da', background: 'white', color: '#444',
  },
  toc: {
    display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: '2rem',
    padding: '0.85rem 1rem', background: 'white', borderRadius: 10, border: '1px solid #e4e6ea',
  },
  tocLink: {
    fontSize: 13, color: '#2F5597', textDecoration: 'none', padding: '4px 10px',
    borderRadius: 999, background: '#f0f3fa',
  },
  section: {
    marginBottom: '1.5rem', background: 'white', borderRadius: 10,
    padding: '1.25rem 1.5rem', border: '1px solid #e4e6ea', scrollMarginTop: 16,
  },
  sectionHeader: { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 10, marginBottom: 10 },
  versionBadge: {
    fontSize: 12.5, fontWeight: 700, color: '#2F5597', background: '#eef1f8',
    borderRadius: 999, padding: '3px 10px',
  },
  h2: { fontSize: 16, margin: 0, color: '#203864', flex: '1 1 auto' },
  date: { fontSize: 12.5, color: '#9aa0a8' },
  list: { margin: 0, paddingLeft: '1.2rem' },
  listItem: { fontSize: 14, lineHeight: 1.6, color: '#333', marginBottom: 6 },
};

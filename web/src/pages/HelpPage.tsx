// Statische uitlegpagina — geen API-calls, puur documentatie voor de
// eindgebruiker. Bereikbaar via het "?"-icoon op het overzichtsscherm en via
// het Help-icoon in de topbar van de boomweergave (tree.html, zie
// TreePage.tsx: postMessage 'doelenboom-navigate' met target 'help'). Inhoud
// is bewust een samenvatting van README.md, niet 1-op-1 gekopieerd — gericht
// op wat een gebruiker nodig heeft om ermee te werken, niet op de
// architectuur/implementatie.

// Vóór SECTIONS gedefinieerd (i.p.v. de gebruikelijke plek onderaan): SECTIONS
// bouwt zijn JSX.Element-content meteen bij module-evaluatie (geen render-
// functie), dus verwijst het al bij het inladen van deze module naar
// `styles` — dat moet dan al bestaan (TDZ, anders "used before declaration").
const styles: Record<string, React.CSSProperties> = {
  main: { fontFamily: 'system-ui, sans-serif', padding: 'clamp(1rem, 4vw, 2rem)', maxWidth: 760, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.25rem' },
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
  h2: { fontSize: 16, margin: '0 0 10px', color: '#203864' },
  p: { fontSize: 14, lineHeight: 1.6, color: '#333', margin: '0 0 10px' },
};

export default function HelpPage({ onBack }: { onBack: () => void }) {
  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Help</h1>
          <p style={styles.subtitle}>Uitleg over het Doelenboom-platform.</p>
        </div>
        <button onClick={onBack} style={styles.backBtn}>← Terug</button>
      </header>

      <nav style={styles.toc} aria-label="Inhoud">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} style={styles.tocLink}>
            {s.title}
          </a>
        ))}
      </nav>

      {SECTIONS.map((s) => (
        <section key={s.id} id={s.id} style={styles.section}>
          <h2 style={styles.h2}>{s.title}</h2>
          {s.content}
        </section>
      ))}
    </main>
  );
}

const SECTIONS: { id: string; title: string; content: JSX.Element }[] = [
  {
    id: 'wat-is-dit',
    title: 'Wat is Doelenboom?',
    content: (
      <>
        <p style={styles.p}>
          Doelenboom is een platform om de doelenboom van een organisatie — de opbouw van projecten en
          capabilities tot aan de missie — visueel bij te houden, te delen en te beheren. Eén platform kan
          meerdere <strong>tenants</strong> (organisaties) bedienen, en elke tenant kan meerdere{' '}
          <strong>doelenbomen</strong> hebben.
        </p>
        <p style={styles.p}>
          Elke doelenboom bestaat uit <strong>elementen</strong> (bijvoorbeeld projecten, capabilities of
          benefits), verdeeld over <strong>kolommen</strong> die samen het pad van project tot missie vormen,
          en <strong>relaties</strong> daartussen. Welke kolommen (types, namen, kleuren, volgorde) een
          doelenboom precies heeft, is per doelenboom instelbaar — zie "Kolommen beheren" verderop.
        </p>
      </>
    ),
  },
  {
    id: 'navigeren',
    title: 'Navigeren in de boomweergave',
    content: (
      <>
        <p style={styles.p}>
          Klik op een vak om het volledige verbonden pad — van dat element tot aan de laatste kolom — te
          markeren. Houd de muis boven een vak voor de volledige omschrijving. Dubbelklik op een vak om erop
          in te zoomen: dan blijven alleen dat element, één niveau erboven en alle onderliggende elementen
          zichtbaar.
        </p>
        <p style={styles.p}>
          Gebruik de zoekbalk boven in de topbar om op code, naam of omschrijving te zoeken — treffers worden
          automatisch onthuld, ook als hun kolom is ingeklapt. De knoppen bij "Kolom links tonen" / "Toon alle
          kolommen" / "Alleen [eerste kolom]" klappen kolommen in of uit; de twee pijl-iconen in de topbar
          wisselen de bouwrichting (links/rechts) en de kijkrichting (welke kolom standaard zichtbaar start).
        </p>
        <p style={styles.p}>
          Via <strong>Filters</strong> in de topbar kun je op tag en/of organisatieonderdeel filteren. De
          legenda onder de topbar toont de kleurbetekenis van elke kolom. Projecten met een RAG-status tonen
          een gekleurde marker (rood/oranje/groen).
        </p>
      </>
    ),
  },
  {
    id: 'bewerken',
    title: 'Elementen, relaties, tags en organisatieonderdelen bewerken',
    content: (
      <>
        <p style={styles.p}>
          Met schrijfrechten (rol admin of sysadmin, zie "Rollen en rechten" verderop) kun je losse wijzigingen
          direct doorvoeren, zonder Excel: "+ Nieuw element" in de knoppenbalk, en "Bewerken"/"Verwijderen" in
          het detailpaneel dat verschijnt als je dubbelklikt op een element. Datzelfde detailpaneel toont ook
          alle inkomende en uitgaande relaties van dat element, met een "+ Relatie"-knop om er een toe te
          voegen.
        </p>
        <p style={styles.p}>
          Tags en organisatieonderdelen beheer je via de "Beheer"-knop naast het filtermenu — daar staan beide
          stamlijsten naast elkaar, elk met een overzicht en een formulier om iets nieuws toe te voegen.
          Wijzigingen hier zijn direct zichtbaar, zonder rapport of publiceerstap.
        </p>
      </>
    ),
  },
  {
    id: 'excel',
    title: 'Excel importeren en exporteren',
    content: (
      <>
        <p style={styles.p}>
          Via <strong>Bestand → Importeer Excel</strong> upload je een referentietabel; het formaat (oud of
          nieuw) wordt automatisch herkend. Na het uploaden zie je eerst een validatierapport — pas na een
          expliciete klik op "Doorvoeren" wordt dit daadwerkelijk gepubliceerd.
        </p>
        <p style={styles.p}>
          <strong>Let op: publiceren is een volledige vervanging.</strong> Alle elementen, relaties, tags,
          producten en organisatieonderdelen van de doelenboom worden dan eerst verwijderd en daarna opnieuw
          ingevoegd vanuit het geüploade bestand. Een rij die in het bestand ontbreekt, verdwijnt dus
          definitief uit de doelenboom.
        </p>
        <p style={styles.p}>
          Via <strong>Bestand → Exporteer als Excel</strong> kies je eerst een formaat (oud of nieuw) en
          daarna een modus: een lege <strong>template</strong> (alleen kolomkoppen) of de{' '}
          <strong>huidige data</strong>. Elk geëxporteerd bestand bevat ook een "Configuratie"-tab (waar het
          vandaan komt) en een "Kolommen"-tab (de kolomconfiguratie van deze doelenboom op het moment van
          exporteren). Het oude formaat is alleen beschikbaar zolang een doelenboom nog de 8 standaardkolommen
          heeft; bij een aangepaste kolomconfiguratie gebruik je het nieuwe formaat.
        </p>
        <p style={styles.p}>
          Los daarvan kun je de boom ook <strong>als SVG</strong> exporteren (het icoon links in de topbar, óók
          bruikbaar met een gemarkeerd pad), of via{' '}
          <strong>Bestand → Exporteer als HTML-bestand</strong> een volledig zelfstandig bestand downloaden dat
          zonder login of internetverbinding werkt — handig om de boom even offline te delen.
        </p>
      </>
    ),
  },
  {
    id: 'rollen',
    title: 'Rollen en rechten',
    content: (
      <>
        <p style={styles.p}>Drie rollen, van breed naar smal:</p>
        <p style={styles.p}>
          <strong>Sysadmin</strong> — systeembreed, mag alles: tenants aanmaken, alle accounts beheren, en
          binnen elke tenant lezen én schrijven.
        </p>
        <p style={styles.p}>
          <strong>Tenant-admin</strong> — mag lezen én wijzigen binnen de tenant(s) waar hij/zij deze rol
          heeft: elementen/relaties/tags/organisatieonderdelen bewerken, Excel importeren/publiceren,
          tenant-instellingen aanpassen en leden beheren. Geen toegang tot andere tenants.
        </p>
        <p style={styles.p}>
          <strong>Tenant-gebruiker</strong> — alleen lezen binnen de tenant(s) waar hij/zij lid van is. Alle
          schrijfknoppen zijn dan verborgen.
        </p>
        <p style={styles.p}>
          Eén account kan lid zijn van meerdere tenants, met eventueel een andere rol per tenant, en een rol
          kan zelfs per doelenboom overruled worden. Rollen worden bij elk verzoek live opgezocht — een
          rolwijziging gaat dus direct in, zonder opnieuw in te loggen.
        </p>
      </>
    ),
  },
  {
    id: 'beheer',
    title: 'Tenants, doelenbomen, kolommen en accounts beheren',
    content: (
      <>
        <p style={styles.p}>
          Sysadmins en tenant-admins zien op het overzichtsscherm een knop <strong>Tenantbeheer</strong>: klik
          op een tenant om instellingen, standaardkolommen, doelenbomen en leden te beheren. Onder een
          doelenboom vind je daar ook <strong>Rollen per lid</strong> (rol overrulen voor die ene doelenboom)
          en <strong>Kolommen</strong> (de eigen kolomconfiguratie van die doelenboom — type, titel, kleur,
          volgorde, welke kolom de "projectrol" vervult).
        </p>
        <p style={styles.p}>
          Een kolom verwijderen of hernoemen kan niet zolang er nog elementen van dat type bestaan — verwijder
          of wijzig die elementen eerst. Een wijziging aan de standaardkolommen van een tenant raakt alleen
          nieuw aangemaakte doelenbomen, nooit bestaande (die hebben hun eigen, onafhankelijke kopie).
        </p>
        <p style={styles.p}>
          Sysadmins zien daarnaast een aparte knop <strong>Accountbeheer</strong>: de globale lijst van alle
          accounts, los van tenants (aanmaken, sysadmin-vlag zetten, wachtwoord resetten, verwijderen).
        </p>
      </>
    ),
  },
];

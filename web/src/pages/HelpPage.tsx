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
  // flexWrap: 'wrap' zodat de titel/knoppen op een smal (mobiel) scherm onder
  // elkaar komen i.p.v. van de rand af te lopen — zie doelenboom_mobiele_analyse.md.
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
  h2: { fontSize: 16, margin: '0 0 10px', color: '#203864' },
  p: { fontSize: 14, lineHeight: 1.6, color: '#333', margin: '0 0 10px' },
  note: {
    fontSize: 13, lineHeight: 1.55, color: '#6c6f76', margin: '0 0 10px',
    padding: '8px 10px', background: '#f7f8fa', borderRadius: 6, borderLeft: '3px solid #d0d4da',
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 10 },
  th: { textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid #e4e6ea', color: '#203864', fontWeight: 700 },
  td: { padding: '6px 8px', borderBottom: '1px solid #eef0f3', color: '#333' },
  tdCenter: { padding: '6px 8px', borderBottom: '1px solid #eef0f3', color: '#333', textAlign: 'center' },
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

// Rij in de "Mogelijkheden per rol"-tabel: label + drie ✓/– vlaggen (bezoeker/
// gebruiker/admin), volgorde van smal naar breed — zelfde volgorde als de
// rangorde in api/src/rbac.ts (ROLE_RANK). Sysadmin staat bewust niet als
// vierde kolom in dezelfde tabel: die rol werkt categorisch anders (zie de
// toelichting direct onder de tabel).
function roleRow(label: string, bezoeker: boolean, gebruiker: boolean, admin: boolean) {
  const flag = (v: boolean) => (v ? '✓' : '–');
  return (
    <tr key={label}>
      <td style={styles.td}>{label}</td>
      <td style={styles.tdCenter}>{flag(bezoeker)}</td>
      <td style={styles.tdCenter}>{flag(gebruiker)}</td>
      <td style={styles.tdCenter}>{flag(admin)}</td>
    </tr>
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
          Via <strong>Filters</strong> in de topbar kun je op tag en/of organisatieonderdeel filteren, of de
          klikbare "Tags / Organisatieonderdelen"-rij onder de legenda gebruiken (die toont ook tags/
          organisatieonderdelen die nog aan niets gekoppeld zijn). De legenda onder de topbar toont de
          kleurbetekenis van elke kolom. Projecten met een RAG-status tonen een gekleurde marker
          (rood/oranje/groen).
        </p>
      </>
    ),
  },
  {
    id: 'hoe-doe-ik',
    title: 'Hoe doe ik …?',
    content: (
      <>
        <p style={styles.note}>
          Een korte, praktische route naar de meestgebruikte handelingen. De meeste hiervan vereisen minimaal
          de rol <strong>gebruiker</strong> — zie "Rollen en rechten" en "Mogelijkheden per rol" verderop voor
          de precieze grens per actie.
        </p>
        <p style={styles.p}>
          <strong>… een nieuw element toevoegen?</strong> Klik op "+ Nieuw element" in de knoppenbalk boven de
          boom, kies het type en vul de velden in.
        </p>
        <p style={styles.p}>
          <strong>… een relatie tussen twee elementen leggen?</strong> Dubbelklik op een element om het
          detailpaneel te openen en klik daar op "+ Relatie".
        </p>
        <p style={styles.p}>
          <strong>… een tag of organisatieonderdeel aan een element koppelen?</strong> Open het detailpaneel
          van het element (dubbelklik erop) — daar staan de knoppen om een tag of organisatieonderdeel te
          koppelen, naast de bestaande koppelingen. De tag/org zelf moet al in de catalogus staan (zie
          "Beheren" hieronder); nieuwe tags/organisatieonderdelen aanmaken kan alleen een tenant-admin.
        </p>
        <p style={styles.p}>
          <strong>… de status (RAG) van een project bijwerken?</strong> Open het project-element; de
          projectkaart toont de RAG-badge met toelichting bovenaan, met een "Bewerken"-knop ernaast.
        </p>
        <p style={styles.p}>
          <strong>… een deliverable of mijlpaal aan een project toevoegen?</strong> Klik op "+ Product" boven
          de sectie "Producten / deliverables" op de projectkaart. Duur, business value, deadline en
          afhankelijkheden van andere producten vul je in via "Bewerken" op de tile.
        </p>
        <p style={styles.p}>
          <strong>… een activiteit toevoegen, of een planning uit MS Project importeren?</strong> Onder de
          Activiteiten-Gantt van een project staan "+ Activiteit" en "Importeren uit MS Project…" — de import
          toont eerst een wijzigingsoverzicht, net als bij Excel (zie hieronder).
        </p>
        <p style={styles.p}>
          <strong>… een afhankelijkheid tussen twee producten of activiteiten leggen?</strong> Open het
          bewerk-formulier van het product of de activiteit; onderaan staat een sectie "Afhankelijkheden" om
          er één toe te voegen of te verwijderen.
        </p>
        <p style={styles.p}>
          <strong>… alle gegevens van één project exporteren of bijwerken als Excel?</strong> Gebruik de
          "Excel"-knop rechtsboven op de projectkaart, of <strong>Bestand → Project exporteren/importeren als
          Excel</strong> (alleen zichtbaar met een geopend project). Zie ook "Excel importeren en exporteren"
          verderop.
        </p>
        <p style={styles.p}>
          <strong>… de boom delen met iemand zonder account?</strong> <strong>Bestand → Exporteer als
          HTML-bestand</strong> levert een volledig zelfstandig bestand op dat zonder login of
          internetverbinding werkt.
        </p>
        <p style={styles.p}>
          <strong>… iemand toegang geven tot een tenant, of iemands rol wijzigen?</strong> Ga via{' '}
          <strong>Tenantbeheer</strong> naar de tenant en beheer daar de leden. Wil je de rol alleen voor één
          specifieke doelenboom afwijkend zetten, gebruik dan "Rollen per lid" onder die doelenboom.
        </p>
        <p style={styles.p}>
          <strong>… een doelenboom op alleen-lezen zetten of archiveren?</strong> Via{' '}
          <strong>Tenantbeheer</strong> → de tenant → de doelenboom-instellingen (vereist tenant-admin of
          sysadmin met toegang tot die tenant).
        </p>
        <p style={styles.p}>
          <strong>… waarom word ik automatisch uitgelogd?</strong> Na een periode zonder activiteit (standaard
          30 minuten, per tenant instelbaar door een tenant-admin) wordt een sessie automatisch beëindigd —
          gewoon opnieuw inloggen volstaat.
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
          Met schrijfrechten (rol gebruiker, admin of sysadmin — zie "Rollen en rechten" verderop) kun je losse
          wijzigingen direct doorvoeren, zonder Excel: "+ Nieuw element" in de knoppenbalk, en
          "Bewerken"/"Verwijderen" in het detailpaneel dat verschijnt als je dubbelklikt op een element.
          Datzelfde detailpaneel toont ook alle inkomende en uitgaande relaties van dat element, met een
          "+ Relatie"-knop om er een toe te voegen.
        </p>
        <p style={styles.p}>
          Tags en organisatieonderdelen aan een element koppelen kan al met de rol gebruiker; de catalogus zelf
          (een nieuwe tag/organisatieonderdeel aanmaken) beheer je als admin via de "Beheer"-knop naast het
          filtermenu — daar staan beide stamlijsten naast elkaar, elk met een overzicht en een formulier om
          iets nieuws toe te voegen. Wijzigingen hier zijn direct zichtbaar, zonder rapport of publiceerstap.
        </p>
      </>
    ),
  },
  {
    id: 'projecten',
    title: 'Projectstatus, producten en activiteiten',
    content: (
      <>
        <p style={styles.note}>
          Deze functies horen bij de optionele module "Projecten" uit het licentiemodel. Heeft de licentie van
          een tenant deze module niet, dan blijven de bijbehorende knoppen en secties gewoon weg — niet
          uitgegrijsd, gewoon onzichtbaar.
        </p>
        <p style={styles.p}>
          Dubbelklik op een project-element om de projectkaart te openen. Bovenaan staat de{' '}
          <strong>projectstatus</strong>: een RAG-badge (rood/oranje/groen) met toelichting, projectstatus
          (Backlog/Actief/On-hold/Gereed/Vervallen), de datum waarop dit gerapporteerd is en een eventueel
          Cluster PPT — via "Bewerken" bij te werken.
        </p>
        <p style={styles.p}>
          Daaronder toont een <strong>tijdlijn</strong> de verwachte én werkelijke opleverdatum van elk
          product op één as: een cirkel voor een deliverable, een ruit voor een mijlpaal, open voor "verwacht"
          en gevuld voor "opgeleverd"/"gehaald". Een stippellijn markeert "vandaag".
        </p>
        <p style={styles.p}>
          De sectie <strong>Producten / deliverables</strong> toont elke deliverable/mijlpaal als tile, met %
          gereed, verwachte/werkelijke opleverdatum en — indien ingevuld — duur, business value en deadline.
          Bovenaan staat de totale business value (gerealiseerd / totaal, gewogen naar % gereed). Via
          "Bewerken" op een tile leg je ook afhankelijkheden tussen producten vast ("hangt af van"). Een
          product met een ingevulde duur krijgt automatisch óók een herkenbaar (gestreept) balkje in de
          Activiteiten-Gantt hieronder, met de verwachte en werkelijke opleverdatum als losse markers.
        </p>
        <p style={styles.p}>
          De inklapbare sectie <strong>Activiteiten</strong> toont een Gantt-balk per activiteit (start-/
          einddatum), met een apart uiterlijk voor een mijlpaal (ruit-icoon) en een fase/samenvattende taak
          (dunnere balk, in-/uitklapbaar). Afhankelijkheden tussen activiteiten (Finish-Start e.a., met
          eventuele vertraging) worden als pijl getekend. Activiteiten kunnen ook in bulk uit een MS
          Project-bestand geïmporteerd worden — net als bij Excel toont dit eerst een wijzigingsoverzicht,
          pas na bevestiging toegepast.
        </p>
        <p style={styles.p}>
          Het icoon "alle project-tijdlijnen" in de topbar toont alle projecten met een geplande datum op één
          gedeelde as — handig om meerdere projecten in één oogopslag te vergelijken.
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
          definitief uit de doelenboom. Deze actie vereist de rol admin.
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
          <strong>Eén project als Excel</strong> is een ander, kleiner formaat: de "Excel"-knop rechtsboven op
          de projectkaart, of <strong>Bestand → Project exporteren/importeren als Excel</strong> (alleen
          zichtbaar met een geopend project), exporteert alle gegevens van precies dat ene project — producten
          en hun afhankelijkheden, activiteiten en hun afhankelijkheden, projectstatus, tags en
          organisatieonderdelen — in één werkboek. Bewerk je dat bestand en importeer je het terug, dan
          toont dit eerst een wijzigingsoverzicht (nieuw/gewijzigd/te verwijderen, per rij aan- of uit te
          vinken); pas na bevestiging wordt het toegepast, en altijd <strong>additief per rij</strong> — nooit
          een volledige vervanging zoals bij "Importeer Excel" hierboven. Deze actie mag ook met de rol
          gebruiker.
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
        <p style={styles.p}>Vier rollen, van breed naar smal:</p>
        <p style={styles.p}>
          <strong>Sysadmin</strong> — systeembreed: tenants aanmaken/verwijderen, licenties/tiers instellen, en
          alle accounts beheren (Accountbeheer), zonder daarvoor zelf lid te hoeven zijn van een tenant. Voor
          toegang tot de daadwerkelijke <em>inhoud</em> van een tenant (de boom zelf, elementen, producten,
          …) geldt voor een sysadmin precies hetzelfde als voor ieder ander: die moet ook zelf lid zijn van die
          tenant, met één van de drie rollen hieronder. Dit is bewust zo — een platformbeheerder hoeft niet in
          de inhoud van elke klant te kunnen kijken om het platform te kunnen beheren.
        </p>
        <p style={styles.p}>
          <strong>Tenant-admin</strong> (rol "admin") — mag lezen én alles wijzigen binnen de tenant(s) waar
          hij/zij deze rol heeft: alle boom-inhoud, én de "instellingen"-laag (kolomconfiguratie, de tag-/
          organisatieonderdeel-catalogus zelf, doelenboom hernoemen/alleen-lezen/archiveren, de volledige
          Excel-import/publiceren, tenant-instellingen en leden beheren). Geen toegang tot andere tenants.
        </p>
        <p style={styles.p}>
          <strong>Tenant-gebruiker</strong> (rol "gebruiker") — mag lezen én de "losse boom-inhoud" wijzigen:
          elementen en relaties, tags/organisatieonderdelen aan een element koppelen (niet de catalogus zelf
          beheren), en — als de Projecten-module actief is — projectstatus, producten/deliverables en
          activiteiten (incl. het exporteren/importeren van één project als Excel). Mag niet de
          kolomconfiguratie of overige instellingen wijzigen, niet de volledige doelenboom via Excel
          importeren, en geen leden of tenants beheren.
        </p>
        <p style={styles.p}>
          <strong>Tenant-bezoeker</strong> (rol "bezoeker") — alleen lezen binnen de tenant(s) waar hij/zij lid
          van is: de boom bekijken, zoeken/filteren, en exporteren (Excel/HTML/SVG). Geen enkele schrijfactie.
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
    id: 'mogelijkheden',
    title: 'Mogelijkheden per rol',
    content: (
      <>
        <p style={styles.p}>
          Een beknopt overzicht van wat elke rol mag <em>binnen een tenant</em> waar iemand lid van is (✓ = mag,
          – = mag niet). Sysadmin-specifieke, tenant-overstijgende taken (tenants/licenties/accounts) staan
          los onder de tabel.
        </p>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Actie</th>
              <th style={styles.th}>Bezoeker</th>
              <th style={styles.th}>Gebruiker</th>
              <th style={styles.th}>Tenant-admin</th>
            </tr>
          </thead>
          <tbody>
            {roleRow('Boom bekijken, zoeken, filteren', true, true, true)}
            {roleRow('Exporteren (Excel/HTML/SVG)', true, true, true)}
            {roleRow('Elementen en relaties aanmaken/bewerken/verwijderen', false, true, true)}
            {roleRow('Tags/organisatieonderdelen aan een element koppelen', false, true, true)}
            {roleRow('Projectstatus (RAG) bijwerken', false, true, true)}
            {roleRow('Producten/deliverables en activiteiten beheren', false, true, true)}
            {roleRow('Eén project exporteren/importeren als Excel', false, true, true)}
            {roleRow('Planning importeren uit MS Project', false, true, true)}
            {roleRow('Tag-/organisatieonderdeel-catalogus beheren', false, false, true)}
            {roleRow('Kolomconfiguratie van een doelenboom wijzigen', false, false, true)}
            {roleRow('Volledige doelenboom importeren/publiceren (Excel)', false, false, true)}
            {roleRow('Doelenboom hernoemen/alleen-lezen zetten/archiveren', false, false, true)}
            {roleRow('Rollen per lid overrulen (voor één doelenboom)', false, false, true)}
            {roleRow('Tenant-instellingen en leden beheren', false, false, true)}
          </tbody>
        </table>
        <p style={styles.p}>
          <strong>Sysadmin</strong> komt hier niet als aparte kolom bij te staan omdat die rol categorisch
          anders werkt: een sysadmin kan altijd, ongeacht tenant-lidmaatschap, tenants aanmaken/verwijderen,
          licenties/tiers instellen en alle accounts beheren (Accountbeheer) — maar heeft voor de rijen
          hierboven, dus voor de daadwerkelijke inhoud van een tenant, gewoon lidmaatschap met één van de drie
          rollen nodig, precies zoals ieder ander.
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

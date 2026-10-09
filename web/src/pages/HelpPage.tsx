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
// editor/admin), volgorde van smal naar breed — zelfde volgorde als de
// rangorde in api/src/rbac.ts (ROLE_RANK). Sysadmin staat bewust niet als
// vierde kolom in dezelfde tabel: die rol werkt categorisch anders (zie de
// toelichting direct onder de tabel).
function roleRow(label: string, bezoeker: boolean, editor: boolean, admin: boolean) {
  const flag = (v: boolean) => (v ? '✓' : '–');
  return (
    <tr key={label}>
      <td style={styles.td}>{label}</td>
      <td style={styles.tdCenter}>{flag(bezoeker)}</td>
      <td style={styles.tdCenter}>{flag(editor)}</td>
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
          en <strong>relaties</strong> daartussen. Een relatie loopt van een element naar het element waaraan
          het bijdraagt, en is primair of ondersteunend. Welke kolommen een doelenboom heeft (types, namen,
          kleuren, volgorde) is per doelenboom instelbaar — zie "Beheren" verderop.
        </p>
        <p style={styles.p}>
          Twee onderdelen zijn optionele modules uit de licentie: <strong>Projecten</strong> (status,
          producten en planning van projecten) en <strong>Controleregels</strong> (regels, kenmerken en
          afwijkingen). Heeft een tenant een module niet, dan zijn de bijbehorende knoppen en secties niet
          zichtbaar.
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
          Klik op een vak om het volledige verbonden pad te markeren. Houd de muis boven een vak voor de
          omschrijving. Dubbelklik op een vak om erop in te zoomen: dan blijven alleen dat element, één niveau
          erboven en alle onderliggende elementen zichtbaar, en opent het detailpaneel met alle gegevens van
          het element. Met "Terug naar vorig scherm" ga je terug naar de hele boom.
        </p>
        <p style={styles.p}>
          <strong>Kolommen tonen en verbergen.</strong> Een boom opent standaard met alleen de laatste kolom zichtbaar.
          Met "Kolom links tonen" klap je er steeds één bij, met "Toon alle kolommen" alles tegelijk, en met
          "Alleen [kolom]" ga je terug naar het begin. Het kruisje boven een kolomkop verbergt die ene kolom;
          een klik op de kolom in de legenda zet hem weer aan of uit. De twee pijl-iconen in de topbar
          wisselen de bouwrichting (links/rechts) en de kijkrichting (welke kolom standaard zichtbaar start).
        </p>
        <p style={styles.p}>
          <strong>Zoeken.</strong> Gebruik de zoekbalk in de topbar om op code, naam of omschrijving te zoeken;
          treffers worden automatisch onthuld, ook als hun kolom verborgen is. Met "Filter op resultaten" laat
          je alleen de bomen zien die de treffers raken.
        </p>
        <p style={styles.p}>
          <strong>Boomfilter.</strong> Ctrl-klik (Mac: Cmd-klik, mobiel: lang indrukken) op een of meer vakken
          en klik daarna op "Toon deze bomen": je ziet dan alleen de bomen die de gekozen elementen raken. Met
          "Wis" hef je het filter op. Onder Filters kun je ook tags of organisatieonderdelen aanzetten en met
          "Toon de bomen van deze N" in één keer de bomen van alle gemarkeerde elementen tonen; de markering
          van de tags verdwijnt dan, de gekozen elementen houden de blauwe rand. "Filter op resultaten" bij
          de zoekbalk werkt op dezelfde manier.
        </p>
        <p style={styles.p}>
          <strong>Filters.</strong> Via <strong>Filters</strong> in de topbar filter je op tag en/of
          organisatieonderdeel; de klikbare rij onder de legenda doet hetzelfde en toont ook tags en
          organisatieonderdelen die nog nergens aan gekoppeld zijn. Met de module Projecten staat daar ook
          "Verouderd": projecten waarvan de status langer dan het ingestelde aantal dagen niet is bijgewerkt.
        </p>
        <p style={styles.p}>
          <strong>Kolomsamenvatting.</strong> Dubbelklik op een kolomkop voor een overzicht van die kolom:
          het aantal elementen, de taakvelden en de elementen per taakveld. Dit overzicht kun je als
          HTML-bestand exporteren.
        </p>
        <p style={styles.p}>
          De legenda onder de topbar toont de kleur van elke kolom. Projecten met een RAG-status tonen een
          gekleurde marker (rood/oranje/groen).
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
          de rol <strong>editor</strong> — zie "Rollen en rechten" en "Mogelijkheden per rol" verderop voor
          de precieze grens per actie.
        </p>
        <p style={styles.p}>
          <strong>… een nieuw element toevoegen?</strong> Klik op "+ Nieuw element" in de knoppenbalk boven de
          boom, kies het type en vul de velden in. Het element komt op codevolgorde in zijn kolom te staan.
        </p>
        <p style={styles.p}>
          <strong>… een relatie tussen twee elementen leggen?</strong> Dubbelklik op een element om het
          detailpaneel te openen en klik daar op "+ Relatie". Voor meerdere relaties achter elkaar: klik op
          "Verbinden", klik de elementen aan in de volgorde van de keten, kies zo nodig primair of
          ondersteunend en klik op "Maak relaties".
        </p>
        <p style={styles.p}>
          <strong>… meerdere elementen tegelijk bewerken of verwijderen?</strong> Klik op "Selecteren" in de
          knoppenbalk en klik de elementen aan; een klik op een kolomkop neemt de hele kolom. In de balk die
          verschijnt kies je "Bewerken…" om type, taakveld, sub-taakveld, tags, organisatieonderdelen of
          kenmerken voor de hele selectie te wijzigen, of "Verwijderen…" (alleen admin). Verwijderen is
          definitief: er is geen prullenbak, dus maak zo nodig eerst een export.
        </p>
        <p style={styles.p}>
          <strong>… de volgorde van elementen in een kolom wijzigen?</strong> Eén element verplaatsen:
          dubbelklik erop en gebruik de pijltjes omhoog en omlaag of "Plaats na…" onderaan het detailpaneel.
          Een hele kolom in één keer sorteren (alleen admin): klik op het pijltjes-knopje boven de kolomkop en
          kies "op code" of "op bovenliggend element". De volgorde wordt opgeslagen en is voor iedereen gelijk.
        </p>
        <p style={styles.p}>
          <strong>… een tag of organisatieonderdeel aan een element koppelen?</strong> Open het detailpaneel
          van het element (dubbelklik erop) — daar staan de knoppen om een tag of organisatieonderdeel te
          koppelen, naast de bestaande koppelingen. De tag of het organisatieonderdeel moet al in de catalogus
          staan; die beheert een tenant-admin via de knop "Beheer" in de topbar.
        </p>
        <p style={styles.p}>
          <strong>… een kenmerk bij een element invullen?</strong> Open het detailpaneel van het element en
          klik in de sectie "Kenmerken" op "Kenmerken bewerken". Zie "Kenmerken" verderop.
        </p>
        <p style={styles.p}>
          <strong>… zien welke elementen niet aan de controleregels voldoen?</strong> Klik op "Controleregels"
          in de topbar. Elementen met een overtreding krijgen een '!'. Zie "Controleregels en afwijkingen"
          verderop.
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
          toont eerst een wijzigingsoverzicht.
        </p>
        <p style={styles.p}>
          <strong>… een afhankelijkheid tussen twee producten of activiteiten leggen?</strong> Open het
          bewerk-formulier van het product of de activiteit; onderaan staat een sectie "Afhankelijkheden" om
          er één toe te voegen of te verwijderen.
        </p>
        <p style={styles.p}>
          <strong>… een statusrapportage van één project maken?</strong> Klik op "PPT" rechtsboven op de
          projectkaart voor een PowerPoint van dat project, of op "Excel" voor alle gegevens als werkboek.
        </p>
        <p style={styles.p}>
          <strong>… een presentatie van de hele doelenboom maken?</strong> Kies <strong>Bestand → Exporteer als
          PowerPoint</strong>. Zie "Importeren en exporteren" verderop.
        </p>
        <p style={styles.p}>
          <strong>… de boom delen met iemand zonder account?</strong> <strong>Bestand → Exporteer als
          HTML-bestand</strong> levert een volledig zelfstandig bestand op dat zonder login of
          internetverbinding werkt.
        </p>
        <p style={styles.p}>
          <strong>… iemand toegang geven tot een tenant, of iemands rol wijzigen?</strong> Ga via{' '}
          <strong>Tenantbeheer</strong> naar de tenant en beheer daar de leden. Wil je de rol alleen voor één
          specifieke doelenboom afwijkend zetten, gebruik dan "Rollen per lid" bij die doelenboom.
        </p>
        <p style={styles.p}>
          <strong>… een doelenboom op alleen-lezen zetten of hernoemen?</strong> Via{' '}
          <strong>Tenantbeheer</strong> → de tenant → "Bewerken" bij de doelenboom (vereist tenant-admin).
        </p>
        <p style={styles.p}>
          <strong>… mijn wachtwoord wijzigen of tweestapsverificatie aanzetten?</strong> Via het
          gebruikersmenu rechtsboven op het overzichtsscherm: "Wachtwoord wijzigen" en "Mijn beveiliging".
        </p>
        <p style={styles.p}>
          <strong>… waarom word ik automatisch uitgelogd?</strong> Na een periode zonder activiteit (standaard
          15 minuten, voor de hele applicatie instelbaar door een sysadmin) wordt een sessie automatisch
          beëindigd — gewoon opnieuw inloggen volstaat. Het inlogscherm noemt dan de geldende termijn.
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
          Met schrijfrechten (rol editor of admin — zie "Rollen en rechten" verderop) kun je wijzigingen direct
          doorvoeren, zonder Excel: "+ Nieuw element" in de knoppenbalk, en "Bewerken"/"Verwijderen" in het
          detailpaneel dat verschijnt als je dubbelklikt op een element. Datzelfde detailpaneel toont ook alle
          inkomende en uitgaande relaties van dat element, met een "+ Relatie"-knop om er een toe te voegen.
        </p>
        <p style={styles.p}>
          <strong>Verbinden.</strong> Met de knop "Verbinden" leg je een hele keten in één keer: klik de
          elementen aan in de gewenste volgorde, kies in de balk die verschijnt zo nodig het relatietype
          (primair of ondersteunend) en een toelichting, en klik op "Maak relaties". Verbinden en Selecteren
          kunnen niet tegelijk aan staan.
        </p>
        <p style={styles.p}>
          <strong>Selecteren.</strong> Met de knop "Selecteren" kies je meerdere elementen om ze in één keer te
          bewerken of (alleen admin) te verwijderen. Een klik op een kolomkop neemt de hele kolom; met
          "+ Zoekresultaten" en "+ Boomfilter-selectie" neem je de treffers van een zoekopdracht of de
          boomfilter-selectie over. Bij verwijderen toont het venster eerst wat er verdwijnt en typ je het
          aantal elementen over ter bevestiging.
        </p>
        <p style={styles.p}>
          <strong>Volgorde.</strong> De volgorde van elementen binnen een kolom wordt opgeslagen en is voor
          iedereen gelijk. Een nieuw element komt op codevolgorde te staan (B9 vóór B10). Verplaatsen doe je
          onderaan het detailpaneel; een hele kolom sorteren kan een admin via het pijltjes-knopje boven de
          kolomkop.
        </p>
        <p style={styles.p}>
          <strong>Tags en organisatieonderdelen.</strong> Koppelen aan een element kan met de rol editor; de
          catalogus zelf (een nieuwe tag of een nieuw organisatieonderdeel aanmaken) beheer je als admin via
          de knop "Beheer" in de topbar — daar staan beide lijsten naast elkaar, elk met een overzicht en een
          formulier om iets toe te voegen. Wijzigingen zijn direct zichtbaar.
        </p>
      </>
    ),
  },
  {
    id: 'kenmerken',
    title: 'Kenmerken',
    content: (
      <>
        <p style={styles.note}>
          Kenmerken horen bij de optionele module "Controleregels". Zonder die module blijven kenmerken en
          ingevulde waarden bewaard, maar zijn ze niet zichtbaar.
        </p>
        <p style={styles.p}>
          Een kenmerk is een eigen veld bij een elementtype, bijvoorbeeld "Laatste beoordeling" (datum) of
          "Classificatie" (keuzelijst). Er zijn vijf soorten: tekst, getal, datum, keuzelijst (één waarde) en
          ja/nee. Leg alleen kenmerken vast die metagegevens zijn; geen inhoudelijke of gerubriceerde
          informatie.
        </p>
        <p style={styles.p}>
          <strong>Definiëren (admin).</strong> Ga naar <strong>Tenantbeheer</strong> → de tenant → "Kolommen"
          bij de doelenboom. Onder de kolommen staat het blok "Kenmerken". Per kenmerk leg je een id, een
          label, de soort, de elementtypen waarvoor het geldt, verplicht ja/nee en een optionele uitleg vast;
          bij een keuzelijst ook de toegestane waarden. Het id en de soort liggen vast na het opslaan. Een
          boom kan maximaal 30 kenmerken hebben. Een alias volgt het type van zijn kolom.
        </p>
        <p style={styles.p}>
          Verwijder je een kenmerk, of een waarde uit een keuzelijst die in gebruik is, dan vervallen de
          ingevulde waarden op de elementen. Het scherm meldt vooraf hoeveel dat er zijn; dit kan niet
          ongedaan worden gemaakt. Een kenmerk dat in een controleregel wordt gebruikt kan niet worden
          verwijderd; pas eerst de regel aan.
        </p>
        <p style={styles.p}>
          <strong>Invullen (editor en admin).</strong> Dubbelklik op een element; in het detailpaneel staat de
          sectie "Kenmerken" met de kenmerken die voor dat type gelden. Klik op "Kenmerken bewerken", vul de
          waarden in en sla op. Een tekstwaarde is maximaal 200 tekens. Een verplicht kenmerk herken je aan
          een rode *; is het na opslaan nog leeg, dan krijg je daar een melding van. Meerdere elementen
          tegelijk invullen kan via "Selecteren" → "Bewerken…".
        </p>
        <p style={styles.p}>
          <strong>Bekijken.</strong> Iedereen met toegang tot de boom ziet de ingevulde kenmerken in het
          detailpaneel en in het kaartje dat verschijnt als je de muis boven een vak houdt. De vakken in de
          boom zelf veranderen niet.
        </p>
        <p style={styles.p}>
          Kenmerken en hun waarden zitten niet in de Excel-export en de PowerPoint-export; een Excel-import
          laat de ingevulde waarden staan. De definities gaan mee in een sjabloon en bij dupliceren, de
          ingevulde waarden niet.
        </p>
      </>
    ),
  },
  {
    id: 'controleregels',
    title: 'Controleregels en afwijkingen',
    content: (
      <>
        <p style={styles.note}>
          Deze functies horen bij de optionele module "Controleregels".
        </p>
        <p style={styles.p}>
          Controleregels toetsen of de boom <em>gedocumenteerd</em> sluitend is — bijvoorbeeld of elke
          capability een bovenliggende benefit heeft. Ze zeggen niets over of iets in de praktijk werkt.
        </p>
        <p style={styles.p}>
          <strong>Regels opstellen (admin).</strong> Ga naar <strong>Tenantbeheer</strong> → de tenant →
          "Kolommen" bij de doelenboom; onder Kolommen en Kenmerken staat het blok "Controleregels". Per regel
          kies je de elementtypen waarvoor hij geldt en een regeltype:
        </p>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Regeltype</th>
              <th style={styles.th}>Wat de regel eist</th>
            </tr>
          </thead>
          <tbody>
            <tr><td style={styles.td}>Heeft ouder van type…</td><td style={styles.td}>Een relatie naar een bovenliggend element van de gekozen typen.</td></tr>
            <tr><td style={styles.td}>Heeft kind van type…</td><td style={styles.td}>Een relatie vanuit een onderliggend element van de gekozen typen.</td></tr>
            <tr><td style={styles.td}>Aantal primaire ouders</td><td style={styles.td}>Een minimum en/of maximum aantal primaire relaties naar boven.</td></tr>
            <tr><td style={styles.td}>Heeft tag in categorie…</td><td style={styles.td}>Minstens één tag uit de gekozen categorie.</td></tr>
            <tr><td style={styles.td}>Veld is ingevuld</td><td style={styles.td}>Omschrijving, KPI, taakveld of sub-taakveld is niet leeg.</td></tr>
            <tr><td style={styles.td}>Kenmerk voldoet aan…</td><td style={styles.td}>De waarde van een kenmerk voldoet aan een eis (zie hieronder).</td></tr>
          </tbody>
        </table>
        <p style={styles.p}>
          Een regel kun je uitzetten zonder hem te verwijderen. Verwijder je een regel, dan vervallen de
          motivaties van afwijkingen bij die regel; het scherm meldt dat vooraf.
        </p>
        <p style={styles.p}>
          <strong>Regels op kenmerken.</strong> Een kenmerk kan op twee manieren een signaal geven. Staat
          "verplicht" aan bij het kenmerk, dan is een leeg kenmerk een overtreding, zonder aparte regel. Met
          het regeltype "Kenmerk voldoet aan…" stel je een eis aan de waarde: bij tekst bijvoorbeeld "bevat"
          of "begint met", bij een getal "is hooguit" of "ligt tussen", bij een datum "is hooguit N dagen oud"
          of "ligt niet in het verleden", bij een keuzelijst "is een van", en bij ja/nee "is ja" of "is nee".
          Zo'n regel toetst alleen ingevulde waarden; alleen "verplicht" maakt een leeg kenmerk tot
          overtreding.
        </p>
        <p style={styles.note}>
          Datumeisen zoals "hooguit 180 dagen oud" worden getoetst tegen de datum van vandaag op het moment dat
          je de boom opent. Een element kan dus een '!' krijgen zonder dat iemand iets heeft gewijzigd.
        </p>
        <p style={styles.p}>
          <strong>Controleweergave.</strong> Heeft een boom actieve regels, dan staat in de topbar de knop
          "Controleregels". Zet je die aan, dan krijgt elk element met een overtreding een '!' en verschijnt
          boven de boom een samenvatting: het aantal elementen met een overtreding en per regel het aantal.
          Klik op een regel om de elementen die hem overtreden te markeren; nogmaals klikken heft dat op. Het
          kaartje bij een vak en het detailpaneel leggen uit welke regel niet gehaald wordt. De aan/uit-stand
          wordt per boom in je browser onthouden.
        </p>
        <p style={styles.p}>
          <strong>Gemotiveerd afwijken (editor en admin).</strong> Is een overtreding bewust, open dan het
          detailpaneel van het element en klik bij de regel op "Motiveer afwijking". Geef een korte motivatie
          op hoofdlijnen (maximaal 500 tekens; geen inhoudelijke, gevoelige of gerubriceerde informatie —
          verwijs zo nodig naar een documentnummer). Het element telt dan niet meer als open overtreding en
          krijgt een grijs signaal in plaats van een '!'. Met "Wijzigen" pas je de motivatie aan, met
          "Intrekken" staat de overtreding weer open. In de samenvatting kun je met "Toon ook gemotiveerde
          afwijkingen" de gemotiveerde gevallen meetellen.
        </p>
        <p style={styles.p}>
          Motivaties van afwijkingen zitten niet in de Excel-export en niet in het zelfstandige HTML-bestand.
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
          Deze functies horen bij de optionele module "Projecten". Heeft de licentie van een tenant deze
          module niet, dan blijven de bijbehorende knoppen en secties gewoon weg — niet uitgegrijsd, gewoon
          onzichtbaar.
        </p>
        <p style={styles.p}>
          Dubbelklik op een project-element om de projectkaart te openen. Bovenaan staat de{' '}
          <strong>projectstatus</strong>: een RAG-badge (rood/oranje/groen) met toelichting, projectstatus
          (Backlog/Actief/On-hold/Gereed/Vervallen), de datum waarop dit gerapporteerd is en een eventueel
          Cluster PPT — via "Bewerken" bij te werken. Is de status langer dan het ingestelde aantal dagen
          niet bijgewerkt, dan krijgt het project de markering "Verouderd"; die drempel stelt een admin per
          doelenboom in.
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
          Project-bestand geïmporteerd worden — dit toont eerst een wijzigingsoverzicht, dat pas na
          bevestiging wordt toegepast.
        </p>
        <p style={styles.p}>
          Rechtsboven op de projectkaart staan twee knoppen: <strong>Excel</strong> (alle gegevens van het
          project exporteren of bijgewerkt terug importeren) en <strong>PPT</strong> (een statusrapportage van
          het project als PowerPoint: overzicht, deliverables, planning en activiteiten).
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
    title: 'Importeren en exporteren',
    content: (
      <>
        <p style={styles.p}>
          <strong>Excel importeren (admin).</strong> Via <strong>Bestand → Importeer Excel</strong> upload je
          een referentietabel; het formaat (oud of nieuw) wordt automatisch herkend. Na het uploaden zie je
          eerst een validatierapport — pas na een expliciete klik op "Doorvoeren" wordt dit daadwerkelijk
          gepubliceerd.
        </p>
        <p style={styles.p}>
          <strong>Let op: publiceren is een volledige vervanging.</strong> Alle elementen, relaties, tags,
          producten en organisatieonderdelen van de doelenboom worden dan eerst verwijderd en daarna opnieuw
          ingevoegd vanuit het geüploade bestand. Een rij die in het bestand ontbreekt, verdwijnt dus
          definitief uit de doelenboom. Ingevulde kenmerken en motivaties van afwijkingen blijven bewaard voor
          elementen waarvan de code in het bestand terugkomt.
        </p>
        <p style={styles.p}>
          <strong>Excel exporteren.</strong> Via <strong>Bestand → Exporteer als Excel</strong> kies je eerst
          een formaat (oud of nieuw) en daarna een modus: een lege <strong>template</strong> (alleen
          kolomkoppen) of de <strong>huidige data</strong>. Elk geëxporteerd bestand bevat ook een
          "Configuratie"-tab (waar het vandaan komt) en een "Kolommen"-tab (de kolomconfiguratie van deze
          doelenboom op het moment van exporteren). Het oude formaat is alleen beschikbaar zolang een
          doelenboom nog de 8 standaardkolommen heeft; bij een aangepaste kolomconfiguratie gebruik je het
          nieuwe formaat.
        </p>
        <p style={styles.p}>
          <strong>PowerPoint van de doelenboom.</strong> Via <strong>Bestand → Exporteer als PowerPoint</strong>{' '}
          maak je een presentatie. De eerste slide toont de kolommen als snoer, met per kolom de omschrijving;
          je kiest zelf hoeveel kolommen er op een regel staan (2 tot 6). Vink aan welke kolommen je per
          element wilt uitwerken: elk element krijgt dan een eigen slide met de boom gefilterd op dat element
          (het hele pad omhoog en omlaag), de beschrijving, de KPI, de verbindingen, tags en
          organisatieonderdelen. Het venster toont vooraf hoeveel slides het worden (maximaal 300).
        </p>
        <p style={styles.note}>
          Kolommen die op het scherm verborgen zijn, komen niet in de presentatie. Een boom opent standaard met
          alleen de laatste kolom zichtbaar: klik dus eerst op "Toon alle kolommen" als je de hele boom wilt
          exporteren.
        </p>
        <p style={styles.p}>
          <strong>Eén project als Excel of PowerPoint</strong> (module Projecten). De "Excel"-knop rechtsboven
          op de projectkaart, of <strong>Bestand → Project exporteren/importeren als Excel</strong> (alleen
          zichtbaar met een geopend project), exporteert alle gegevens van precies dat ene project — producten
          en hun afhankelijkheden, activiteiten en hun afhankelijkheden, projectstatus, tags en
          organisatieonderdelen — in één werkboek. Bewerk je dat bestand en importeer je het terug, dan
          toont dit eerst een wijzigingsoverzicht (nieuw/gewijzigd/te verwijderen, per rij aan- of uit te
          vinken); pas na bevestiging wordt het toegepast, en altijd <strong>per rij</strong> — nooit een
          volledige vervanging zoals bij "Importeer Excel" hierboven. Dit mag ook met de rol editor. De
          "PPT"-knop ernaast downloadt een statusrapportage van het project.
        </p>
        <p style={styles.p}>
          <strong>HTML en SVG.</strong> Via <strong>Bestand → Exporteer als HTML-bestand</strong> download je
          een volledig zelfstandig bestand dat zonder login of internetverbinding werkt — handig om de boom
          te delen. Het icoon links in de topbar exporteert de boom als SVG-afbeelding, ook met een
          gemarkeerd pad.
        </p>
        <p style={styles.p}>
          Elke export met inhoud wordt vastgelegd in het auditlogboek: wie, welke boom en welk formaat.
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
          hij/zij deze rol heeft: alle boom-inhoud, én de "instellingen"-laag (kolommen, kenmerken en
          controleregels, de catalogus van tags en organisatieonderdelen, doelenboom hernoemen of op
          alleen-lezen zetten, de volledige Excel-import, sjablonen, tenant-instellingen en leden beheren).
          Geen toegang tot andere tenants.
        </p>
        <p style={styles.p}>
          <strong>Tenant-editor</strong> (rol "editor") — mag lezen én de "losse boom-inhoud" wijzigen:
          elementen en relaties, de volgorde van elementen, tags/organisatieonderdelen aan een element koppelen
          (niet de catalogus zelf beheren), en — met de bijbehorende module — kenmerken invullen, afwijkingen
          motiveren, projectstatus, producten/deliverables en activiteiten (incl. het exporteren/importeren
          van één project als Excel). Mag niet de kolommen, kenmerkdefinities, controleregels of overige
          instellingen wijzigen, niet de volledige doelenboom via Excel importeren, geen elementen in bulk
          verwijderen en geen leden of tenants beheren.
        </p>
        <p style={styles.p}>
          <strong>Tenant-bezoeker</strong> (rol "bezoeker") — alleen lezen binnen de tenant(s) waar hij/zij lid
          van is: de boom bekijken, zoeken/filteren, de controleweergave gebruiken en exporteren
          (Excel/PowerPoint/HTML/SVG). Geen enkele schrijfactie.
        </p>
        <p style={styles.p}>
          Eén account kan lid zijn van meerdere tenants, met eventueel een andere rol per tenant, en een rol
          kan per doelenboom afwijkend worden gezet. Rollen worden bij elk verzoek live opgezocht — een
          rolwijziging gaat dus direct in, zonder opnieuw in te loggen.
        </p>
        <p style={styles.p}>
          Staat een doelenboom op <strong>alleen-lezen</strong>, of is de licentie van de tenant verlopen,
          dan kan niemand er nog iets in wijzigen, ongeacht rol. Bekijken en exporteren blijft mogelijk.
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
          los onder de tabel. Regels met een module erachter gelden alleen als de tenant die module heeft.
        </p>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Actie</th>
              <th style={styles.th}>Bezoeker</th>
              <th style={styles.th}>Editor</th>
              <th style={styles.th}>Tenant-admin</th>
            </tr>
          </thead>
          <tbody>
            {roleRow('Boom bekijken, zoeken, filteren', true, true, true)}
            {roleRow('Exporteren (Excel/PowerPoint/HTML/SVG)', true, true, true)}
            {roleRow('Controleweergave en kenmerken bekijken (Controleregels)', true, true, true)}
            {roleRow('Elementen en relaties aanmaken/bewerken/verwijderen', false, true, true)}
            {roleRow('Meerdere elementen tegelijk bewerken', false, true, true)}
            {roleRow('Een element verplaatsen binnen zijn kolom', false, true, true)}
            {roleRow('Tags/organisatieonderdelen aan een element koppelen', false, true, true)}
            {roleRow('Kenmerken invullen (Controleregels)', false, true, true)}
            {roleRow('Afwijking van een controleregel motiveren (Controleregels)', false, true, true)}
            {roleRow('Projectstatus (RAG) bijwerken (Projecten)', false, true, true)}
            {roleRow('Producten/deliverables en activiteiten beheren (Projecten)', false, true, true)}
            {roleRow('Eén project exporteren/importeren als Excel (Projecten)', false, true, true)}
            {roleRow('Planning importeren uit MS Project (Projecten)', false, true, true)}
            {roleRow('Meerdere elementen tegelijk verwijderen', false, false, true)}
            {roleRow('Een hele kolom sorteren', false, false, true)}
            {roleRow('Catalogus van tags en organisatieonderdelen beheren', false, false, true)}
            {roleRow('Kolommen en aliassen van een doelenboom wijzigen', false, false, true)}
            {roleRow('Kenmerken definiëren en controleregels opstellen (Controleregels)', false, false, true)}
            {roleRow('Volledige doelenboom importeren/publiceren (Excel)', false, false, true)}
            {roleRow('Doelenboom aanmaken, hernoemen, op alleen-lezen zetten of verwijderen', false, false, true)}
            {roleRow('Doelenboom opslaan als sjabloon; sjablonen van de eigen tenant beheren', false, false, true)}
            {roleRow('Rollen per lid afwijkend zetten (voor één doelenboom)', false, false, true)}
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
    title: 'Beheren: tenants, doelenbomen, kolommen, sjablonen en accounts',
    content: (
      <>
        <p style={styles.p}>
          Sysadmins en tenant-admins zien op het overzichtsscherm de knoppen <strong>Tenantbeheer</strong> en{' '}
          <strong>Sjablonen</strong>. In Tenantbeheer klik je op een tenant om de instellingen, de
          doelenbomen en de leden te beheren.
        </p>
        <p style={styles.p}>
          <strong>Instellingen van de tenant.</strong> Hier stel je in: na hoeveel minuten zonder actieve
          sessie de tenant als verlaten geldt (voor het automatisch leegmaken van doelenbomen; dit logt
          niemand uit), of tweestapsverificatie verplicht is voor alle leden, of elk account met een login
          automatisch een rol krijgt in deze tenant ("open toegang"), en of er een melding verschijnt zodra
          iemand een doelenboom in deze tenant opent. Daarnaast twee standaardinstellingen voor nieuwe
          doelenbomen: automatisch leegmaken zodra niemand meer toegang heeft, en meenemen in de nachtelijke
          Excel-back-up.
        </p>
        <p style={styles.p}>
          <strong>Doelenbomen.</strong> Een nieuwe doelenboom start vanuit een sjabloon of vanuit de
          standaardkolommen van de tenant. Per doelenboom staan de knoppen "Rollen per lid" (de rol van een
          lid afwijkend zetten voor die ene boom), "Kolommen", "Opslaan als sjabloon", "Bewerken" (naam,
          alleen-lezen, automatisch leegmaken, nachtelijke back-up en na hoeveel dagen een project als
          verouderd telt) en "Verwijderen".
        </p>
        <p style={styles.p}>
          <strong>Kolommen.</strong> Onder "Kolommen" beheer je de kolomconfiguratie van een doelenboom: per
          kolom het type, de titel, de omschrijving, de kleur, het label van de relatie naar de volgende
          kolom, en welke kolom de "projectrol" vervult (precies één). Een kolom kan <strong>aliassen</strong>{' '}
          hebben: extra elementtypen die in dezelfde kolom staan, elk met een optionele eigen kleur. Een
          kolom verwijderen of hernoemen kan niet zolang er nog elementen van dat type bestaan. Op hetzelfde
          scherm staan, met de module Controleregels, de blokken Kenmerken en Controleregels.
        </p>
        <p style={styles.p}>
          <strong>Sjablonen.</strong> Een sjabloon is een momentopname van een doelenboom — kolommen,
          elementen, relaties, kenmerkdefinities en controleregels — waarmee een nieuwe doelenboom op de
          juiste structuur start. Je maakt er een via "Opslaan als sjabloon" bij een doelenboom. Latere
          wijzigingen aan die doelenboom werken niet door in het sjabloon; met "Vervangen vanuit boom" op het
          scherm Sjablonen werk je het sjabloon bij. Een sjabloon geldt voor de eigen tenant; alleen een
          sysadmin kan een sjabloon systeembreed beschikbaar maken.
        </p>
        <p style={styles.p}>
          <strong>Alleen voor sysadmins.</strong> In Tenantbeheer: tenants aanmaken en hernoemen, de licentie
          van een tenant, de standaardkolommen van een tenant (gelden alleen voor nieuwe doelenbomen) en een
          doelenboom dupliceren. Op het overzichtsscherm de knop "Aanvragen" (abonnementsaanvragen). In het
          gebruikersmenu rechtsboven:
        </p>
        <table style={styles.table}>
          <tbody>
            <tr><td style={styles.td}>Accountbeheer</td><td style={styles.td}>Alle accounts: aanmaken, sysadmin-vlag, wachtwoord resetten, verwijderen.</td></tr>
            <tr><td style={styles.td}>Licentiebeheer</td><td style={styles.td}>Tiers, modules, prijzen en aanbiedingen.</td></tr>
            <tr><td style={styles.td}>Klantbeheer</td><td style={styles.td}>Contactpersonen, klantgegevens en abonnementen per tenant.</td></tr>
            <tr><td style={styles.td}>DB-status</td><td style={styles.td}>Alle tenants met hun doelenbomen en aantallen.</td></tr>
            <tr><td style={styles.td}>Login-overzicht</td><td style={styles.td}>Wie ingelogd is (geweest) en wanneer.</td></tr>
            <tr><td style={styles.td}>Auditlogboek</td><td style={styles.td}>Beveiligingsgebeurtenissen, zoals inloggen, exports en bulkverwijderingen.</td></tr>
            <tr><td style={styles.td}>Softwarecomponenten</td><td style={styles.td}>Overzicht van alle software-onderdelen (SBOM), met nieuwere versies en bekende kwetsbaarheden. Alleen signalerend; er wordt niets automatisch bijgewerkt.</td></tr>
          </tbody>
        </table>
      </>
    ),
  },
  {
    id: 'account',
    title: 'Account en beveiliging',
    content: (
      <>
        <p style={styles.p}>
          Het gebruikersmenu staat rechtsboven op het overzichtsscherm.
        </p>
        <p style={styles.p}>
          <strong>Wachtwoord wijzigen.</strong> Vul je huidige wachtwoord en twee keer het nieuwe in. Een
          wachtwoord is minstens 8 tekens. Heeft een beheerder je account aangemaakt of je wachtwoord gereset,
          dan moet je bij de eerste login een eigen wachtwoord kiezen.
        </p>
        <p style={styles.p}>
          <strong>Tweestapsverificatie.</strong> Onder "Mijn beveiliging" zet je tweestapsverificatie aan of
          uit. Staat het aan, dan krijg je bij elke login, naast je wachtwoord, een tijdelijke code per e-mail.
          Voor sysadmins is dit verplicht, en een tenant-admin kan het verplicht stellen voor alle leden van
          de tenant; in die gevallen kun je het niet zelf uitzetten. Kom je niet meer bij je code, neem dan
          contact op met een tenant-admin of sysadmin.
        </p>
        <p style={styles.p}>
          <strong>Automatisch uitloggen.</strong> Na een periode zonder activiteit eindigt je sessie: standaard
          15 minuten, door een sysadmin in te stellen van 5 tot en met 480 minuten onder Accountbeheer →
          Inlogbeveiliging. Daar staat ook na hoeveel mislukte inlogpogingen inloggen tijdelijk wordt
          geblokkeerd, en voor hoe lang.
        </p>
        <p style={styles.p}>
          <strong>Over Doelenboom.</strong> Dit menu-item toont de versie en de releasegeschiedenis. De
          gebruiksvoorwaarden en de privacyverklaring staan op het inlogscherm.
        </p>
      </>
    ),
  },
  {
    id: 'licentie',
    title: 'Licentie en modules',
    content: (
      <>
        <p style={styles.p}>
          Elke tenant heeft een licentie. Die bepaalt drie dingen: de <strong>tier</strong> (het maximum
          aantal admins en editors samen, en het maximum aantal doelenbomen), de <strong>modules</strong>{' '}
          (Projecten, Controleregels) en de <strong>einddatum</strong>. Bezoekers tellen niet mee voor het
          maximum. De licentie wordt beheerd door een sysadmin.
        </p>
        <p style={styles.p}>
          <strong>Modules.</strong> Zonder een module zijn de bijbehorende knoppen en secties niet zichtbaar.
          Gegevens die eerder met de module zijn vastgelegd blijven bewaard en komen terug zodra de module
          weer actief is.
        </p>
        <p style={styles.p}>
          <strong>Limiet bereikt.</strong> Is het maximum aantal admins/editors of doelenbomen bereikt, dan
          kun je er geen meer toevoegen tot er een vrijkomt of de tier wordt verhoogd.
        </p>
        <p style={styles.p}>
          <strong>Licentie verlopen.</strong> Na de einddatum staat de hele tenant op alleen-lezen, voor
          iedereen: bekijken en exporteren kan nog, wijzigen niet. In de boom staat dan een watermerk. Neem
          contact op om te verlengen.
        </p>
      </>
    ),
  },
];

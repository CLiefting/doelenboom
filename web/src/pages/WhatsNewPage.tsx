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
    // DOEL-123
    version: '4.4.2',
    date: '25 oktober 2026',
    title: 'Beveiligingsupdate: kwetsbaarheden in softwarecomponenten van de server opgelost',
    items: [
      'Twee componenten in de server die binnenkomende verzoeken en bestandsuploads verwerken (body-parser en multer) zijn bijgewerkt. Daarmee zijn twee hoge kwetsbaarheden opgelost waarmee de server via een speciaal geprepareerd verzoek onbereikbaar gemaakt zou kunnen worden; de dagelijkse controle van de softwarecomponenten had ze op 24 oktober 2026 gemeld.',
      'De component voor het versturen van e-mail (nodemailer) is in dezelfde ronde bijgewerkt; dat lost drie kwetsbaarheden van gemiddelde ernst op in het verwerken van e-mailadressen.',
      'Automatische tests bewaken dat deze componenten op een veilige versie blijven.',
      'Er verandert niets aan hoe je Doelenboom gebruikt.',
    ],
  },
  {
    // DOEL-121
    version: '4.4.1',
    date: '21 oktober 2026',
    title: 'Beveiligingsupdate: kwetsbaarheden in een softwarecomponent opgelost',
    items: [
      'De component voor het verwerken van afbeeldingen in de Excel- en PowerPoint-functies (Pillow) is bijgewerkt naar versie 13.0.0. Daarmee zijn één kritieke en zes hoge kwetsbaarheden opgelost die op 20 oktober 2026 bekend werden en door de dagelijkse controle van de softwarecomponenten waren gemeld.',
      'Die component staat voortaan vast op een veilige versie, zodat een nieuwe build niet ongemerkt een kwetsbare versie kan binnenhalen; een automatische test bewaakt dat.',
      'Er verandert niets aan hoe je Doelenboom gebruikt.',
    ],
  },
  {
    version: '4.4.0',
    date: '16 oktober 2026',
    title: 'Programma-PowerPoint: meerdere projecten in één presentatie',
    items: [
      'Nieuw onder Bestand: "Programma als PowerPoint". Vink de projecten aan die je wilt meenemen; de eerste slide toont de tijdlijnen van de projecten met een planning op één tijdas, met fasen, mijlpalen, een peildatum-lijn en de RAG-status als kleur. Altijd op één slide, ook bij veel projecten.',
      'De tweede slide toont de tijdlijnen van álle gekozen projecten, ook die nog zonder planning, op één slide. De derde slide toont alle projecten in één oogopslag: per project de RAG-kleur, het aantal open en te late deliverables en de eerstvolgende datum.',
      'Project-PowerPoint en voortgangsslides: de tijdlijn laat nu zien wát er gepland staat. Mijlpalen hebben hun naam erbij; deliverables hebben een nummer en staan met datum, naam en stand (opgeleverd, percentage of te laat) in een lijst onder de tijdlijn. Te late items zijn rood, deadlines staan als rood driehoekje op de as. In de programma-PowerPoint wordt de geplande datum van een al opgeleverd item weggelaten. De aandachtspunten staan voortaan bovenin, naast de projectstatus.',
      'Daarna de openstaande deliverables van alle gekozen projecten: bovenaan in rood wat te laat is, dan de komende maanden (standaard 3, instelbaar tot 12) en later, op datum, en tot slot wat nog geen datum heeft. Past het niet op één slide, dan loopt het door op vervolgslides.',
      'Een slide "Bijdrage aan doelen" laat per project zien aan welke elementen het direct bijdraagt en welke doelen het uiteindelijk dient. Daarna volgt per project, alfabetisch, de voortgangsslide uit de project-PowerPoint.',
      'Klik op een project of deliverable om naar de voortgangsslide van dat project te springen; de "Home"-knop brengt je terug naar de tijdlijnen.',
      'Bewaar een selectie onder een eigen naam (bijvoorbeeld "Stuurgroep") en exporteer later met één klik dezelfde set. Een selectie is persoonlijk en alleen voor jou zichtbaar.',
    ],
  },
  {
    version: '4.3.1',
    date: '16 oktober 2026',
    title: 'PowerPoint-export: bladeren tussen broertjes',
    items: [
      'PowerPoint van de doelenboom: op elke element-slide staan rechtsonder, naast "Home", de knoppen "◄ Vorige" en "Volgende ►". Daarmee spring je direct naar het vorige of volgende element onder dezelfde ouder, zonder eerst via de ouder te gaan.',
      'Broertjes zijn elementen in dezelfde kolom met dezelfde primaire ouder, in de volgorde van de boom. Vervolgslides worden overgeslagen; is er geen vorig of volgend broertje, dan is de knop grijs.',
      'In de boom bovenaan de slide staan boven en onder het geselecteerde element vage kaartjes van het vorige (▲) en volgende (▼) broertje; klik erop om ernaartoe te gaan. De legenda onder de boom laat zien waar je bent, bijvoorbeeld "2 van 7".',
    ],
  },
  {
    version: '4.3.0',
    date: '11 oktober 2026',
    title: 'Beheer: een doelenboom van de ene omgeving naar de andere kopiëren',
    items: [
      'Voor beheerders: een doelenboom die lokaal is opgebouwd kan met één commando naar productie worden gekopieerd, met alle inhoud: kolommen, controleregels, kenmerken, elementen, relaties, tags, organisatieonderdelen, projectstatus, producten en activiteiten.',
      'De tenant en de doelenboom mogen op productie anders heten dan lokaal. Bestaan ze nog niet, dan worden ze aangemaakt; een bestaande doelenboom wordt alleen vervangen als daar uitdrukkelijk om is gevraagd, na een back-up.',
      'Eerst een proefrun die laat zien wat er gaat gebeuren. De kopie zelf gebeurt in één keer: lukt er iets niet, dan verandert er niets. Gebruikers, rollen en historie gaan niet mee.',
    ],
  },
  {
    // 4.2.0 is wel getagd maar nooit in productie gekomen (DOEL-108: het
    // uitrolscript stopte halverwege); 4.2.1 is dezelfde inhoud, nu wel live.
    version: '4.2.1',
    date: '11 oktober 2026',
    title: 'PowerPoint-export: de totale boom op één slide, ook gefilterd',
    items: [
      'PowerPoint van de doelenboom: de tweede slide toont de totale boom, met alle zichtbare kolommen naast elkaar, al hun elementen en de relaties ertussen. De vakken schalen mee, zodat de boom ook bij tientallen elementen per kolom op één slide past.',
      'Klik in de totale boom op een kolomkop met donkere rand om naar de tussenslide van die kolom te springen, of op een element om naar de eigen slide te gaan.',
      'De tussenslide van een kolom toont alle elementen van die kolom als klikbare blokjes in de kolomkleur.',
      'Elke slide heeft rechtsonder een "Home"-knop waarmee je terugspringt naar de totale boom.',
      'Staat er een Boomfilter aan ("Toon deze bomen"), dan exporteert de PowerPoint standaard alleen die gefilterde boom, met dezelfde lijnen als op het scherm. Met het vinkje "Alleen de gefilterde boom" in het exportvenster kies je toch voor de hele boom.',
      'Het exportvenster telt de extra slide mee (maximaal 300 slides).',
    ],
  },
  {
    version: '4.1.0',
    date: '11 oktober 2026',
    title: 'Klikbare PowerPoint-export, instelbaar automatisch uitloggen',
    items: [
      'PowerPoint van de doelenboom: de beschrijving, KPI, tags en organisatieonderdelen staan links op maximaal een derde van de breedte; de verbonden elementen staan rechts als blokjes in de kleur van hun kolom (gestippelde rand = ondersteunende relatie).',
      'Klik in de presentatie op een blokje of op een vak in de boom om naar de slide van dat element te springen. Ook elementen die in de boom onder "+ meer" vallen staan als blokje op de slide; vervolgslides voor alleen verbindingen zijn daardoor meestal niet meer nodig.',
      'Sysadmin: de termijn voor automatisch uitloggen bij inactiviteit is instelbaar (5 tot 480 minuten, standaard 15) onder Accountbeheer → Inlogbeveiliging.',
      'Filters: "Toon de bomen van deze N" en "Filter op resultaten" wissen daarna de chipfilter of zoekopdracht, zodat het gevonden pad niet meer gedimd blijft.',
    ],
  },
  {
    version: '4.0.1',
    date: '5 oktober 2026',
    title: 'Helppagina bijgewerkt',
    items: [
      'De helppagina is nagelopen en aangevuld: nieuwe secties over kenmerken, controleregels en afwijkingen, account en beveiliging, en licentie en modules.',
      'De tabel "Mogelijkheden per rol" bevat nu ook de acties die sinds 1.10 zijn toegevoegd.',
    ],
  },
  {
    version: '4.0.0',
    date: '5 oktober 2026',
    title: 'Doelenboom exporteren als PowerPoint',
    items: [
      'Bestand → Exporteer als PowerPoint: de eerste slide toont de kolommen als snoer, met 2 tot 6 kolommen per regel.',
      'Per aangevinkte kolom een slide per element: de boom gefilterd op dat element (het hele pad omhoog en omlaag), met beschrijving, KPI, verbindingen, tags en organisatieonderdelen.',
      'Kolommen die op het scherm verborgen zijn komen niet in de presentatie; het venster toont vooraf het aantal slides (maximaal 300).',
    ],
  },
  {
    version: '3.6.0',
    date: '5 oktober 2026',
    title: 'Meerdere elementen tegelijk bewerken; volgorde van elementen',
    items: [
      'Selecteren: meerdere elementen kiezen en in één keer bewerken (type, taakveld, tags, organisatieonderdelen, kenmerken) of verwijderen (alleen admin).',
      'Een nieuw element komt op codevolgorde in zijn kolom te staan.',
      'Een element verplaatsen binnen zijn kolom (omhoog, omlaag of "Plaats na…"); een hele kolom sorteren op code of op bovenliggend element (alleen admin).',
      'Kenmerken: een verplicht kenmerk is herkenbaar aan een rode *, en na opslaan volgt een melding als het nog leeg is.',
    ],
  },
  {
    version: '3.5.0',
    date: '3 oktober 2026',
    title: 'Kenmerken per elementtype',
    items: [
      'Eigen kenmerken per elementtype definiëren: tekst, getal, datum, keuzelijst of ja/nee (module Controleregels).',
      'Kenmerken invullen in het detailpaneel; zichtbaar in het detailpaneel en in het kaartje bij een vak.',
      'Controleregels op kenmerken: een verplicht kenmerk, en het regeltype "Kenmerk voldoet aan…" met een eis per soort.',
    ],
  },
  {
    version: '3.4.0 / 3.4.1',
    date: '2 oktober 2026',
    title: 'Softwarecomponenten en beveiligingsonderhoud',
    items: [
      'Het overzicht Softwarecomponenten wordt direct na een uitrol bijgewerkt.',
      'Sysadmins krijgen een e-mail bij nieuw gemelde kwetsbaarheden.',
      'Dependency-updates; een onnodig onderdeel is uit de image van de excel-service gehaald.',
    ],
  },
  {
    version: '3.3.0',
    date: '2 oktober 2026',
    title: 'Gemotiveerd afwijken van een controleregel',
    items: [
      'Per element en controleregel een afwijking motiveren; het element telt dan niet meer als open overtreding en krijgt een grijs signaal.',
      'De samenvatting telt open en gemotiveerde afwijkingen apart.',
    ],
  },
  {
    version: '3.2.0 – 3.2.2',
    date: '1 en 2 oktober 2026',
    title: 'Controleregels en aliassen',
    items: [
      'Nieuwe module Controleregels: per doelenboom regels opstellen die toetsen of de boom sluitend is, met een "!" op elementen die niet voldoen en een samenvatting per regel.',
      'Het kaartje bij een vak legt uit waarom een element een "!" heeft.',
      'Aliassen: extra elementtypen binnen één kolom, elk met een optionele eigen kleur.',
      'Beveiligingsupdates van de e-mailverzending en van dependencies.',
    ],
  },
  {
    version: '3.1.0 – 3.1.3',
    date: '19 september 2026',
    title: 'Beveiligingsronde en project-PowerPoint',
    items: [
      'Registratie met e-mailverificatie en een limiet op het aantal pogingen; tijdelijke blokkade na herhaald mislukt inloggen.',
      'Sessies kunnen worden ingetrokken; beveiligingsgebeurtenissen komen in het auditlogboek.',
      'Open toegang per tenant: elk account krijgt minstens een ingestelde rol; een doelenboom kan automatisch worden leeggemaakt zodra niemand meer toegang heeft.',
      'Foutmeldingen tonen geen interne details meer; strengere beveiligingsheaders en afgeschermde containers.',
      'PowerPoint-rapportage van één project ("PPT" op de projectkaart).',
      'Overgestapt op Node 24.',
    ],
  },
  {
    version: '1.10.0',
    date: '19 september 2026',
    title: 'Verbindmodus',
    items: [
      'Verbinden: elementen in volgorde aanklikken en in één keer een keten van relaties maken.',
      'E-mail aan sysadmins bij een nieuwe abonnementsaanvraag.',
      'Het overzicht Softwarecomponenten wordt met de applicatie meegeleverd.',
      'Opgelost: een relatie die een kolom overslaat viel weg bij een boomfilter.',
    ],
  },
  {
    version: '1.9.0',
    date: '16 september 2026',
    title: 'Aanbiedingen',
    items: [
      'Aanbiedingenpaneel in Licentiebeheer, zichtbaar op de aanvraagpagina.',
      'De footer toont van welke versie van de broncode de applicatie is gebouwd.',
    ],
  },
  {
    version: '1.8.0 / 1.8.1',
    date: '7 september 2026',
    title: 'Nieuwe prijsstrategie en rol editor',
    items: [
      'Nieuwe rol editor, tussen bezoeker en admin.',
      'Licentielimiet op het aantal admins en editors samen; nieuwe tiers en een vaste opslag per module, met maandfacturatie.',
      'Een abonnementsvorm zonder prijs voor de gekozen periode is niet meer aan te vragen.',
    ],
  },
  {
    version: '1.7.1',
    date: '6 september 2026',
    title: 'Over Doelenboom',
    items: ['Nieuw menu-item "Over Doelenboom" met deze releasegeschiedenis.'],
  },
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

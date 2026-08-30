-- Migratie: juridische documenten (gebruiksvoorwaarden/privacyverklaring) met
-- versiebeheer + acceptatie, en automatische opschoning van langdurig
-- inactieve gebruikersaccounts (12 maanden, met een waarschuwing ~30 dagen
-- vooraf) -- zie Doelenboom_Gebruiksvoorwaarden_v0.3.docx paragraaf 4.1/7 en
-- docs/juridische-documenten-en-retentie.md voor de volledige toelichting.
-- Draai dit een keer tegen een BESTAANDE database (lokale dev-db en
-- productie); voor VERSE installaties staat dit al in db/init.sql.
--
-- Gebruik (lokaal):
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0017_legal_and_retention.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
--
-- Idempotent: create table/column "if not exists", en de content-seed van
-- Gebruiksvoorwaarden v0.3 staat achter "on conflict (doc_type, version) do
-- nothing" zodat een herhaalde run nooit een eventuele latere handmatige
-- correctie overschrijft.

create table if not exists legal_documents (
  id bigserial primary key,
  doc_type text not null check (doc_type in ('terms', 'privacy')),
  version text not null,
  effective_date date not null,
  published_at timestamptz,
  status text not null default 'draft' check (status in ('draft', 'published')),
  -- Moet een gebruiker die een OUDERE versie al accepteerde opnieuw
  -- accepteren zodra dit de geldende versie wordt? Geen juridische keuze die
  -- hier wordt gemaakt -- puur een schakelaar; zie
  -- docs/juridische-documenten-en-retentie.md voor wie 'm zet en wanneer.
  requires_reacceptance boolean not null default true,
  -- Letterlijke brontekst (licht Markdown-achtig: '## '/'### ' voor koppen,
  -- '- ' voor opsommingen, lege regel = alinea-scheiding) -- bewust
  -- ongewijzigd overgenomen uit het aangeleverde brondocument. Nieuwe versies
  -- komen erbij via een nieuwe migratie, niet via een in-app editor -- zelfde
  -- reden: dit is geen content die de applicatie zelf mag herformuleren.
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (doc_type, version)
);
create index if not exists idx_legal_documents_current on legal_documents(doc_type, status, published_at desc);

-- Server-side, auditbare registratie van acceptatie (niet uitsluitend
-- frontendstate/cookies/localStorage). Cascade op user_id: na een
-- accountverwijdering (zie users hieronder) heeft "wie" geen zin meer om te
-- bewaren -- dataminimalisatie, zelfde afweging als bij
-- account_retention_events hieronder.
create table if not exists legal_acceptances (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  legal_document_id bigint not null references legal_documents(id) on delete restrict,
  accepted_at timestamptz not null default now(),
  unique (user_id, legal_document_id)
);
create index if not exists idx_legal_acceptances_user on legal_acceptances(user_id);

-- Inactiviteitsbeleid (Gebruiksvoorwaarden v0.3 paragraaf 4.1): last_login_at
-- is het gekozen, duurzame activiteitssignaal (i.t.t. sessions.last_activity_at,
-- dat per-sessie/per-tab is en bedoeld voor de 15-minuten-uitlogbeveiliging,
-- zie IDLE_TIMEOUT_MINUTES in auth.ts) -- zie accountRetention.ts.
alter table users add column if not exists last_login_at timestamptz;
alter table users add column if not exists inactivity_warning_sent_at timestamptz;
alter table users add column if not exists scheduled_deletion_at timestamptz;
create index if not exists idx_users_scheduled_deletion on users(scheduled_deletion_at) where scheduled_deletion_at is not null;

-- Auditlog voor de retentie-levenscyclus, zelfde patroon als license_events
-- (db/migrations/0015_subscription_requests.sql): user_id "on delete set
-- null" zodat de gebeurtenis "account verwijderd wegens inactiviteit" zelf
-- overleeft als anoniem historisch record nadat de gebruiker (in dezelfde
-- transactie) daadwerkelijk verwijderd wordt.
create table if not exists account_retention_events (
  id bigserial primary key,
  user_id bigint references users(id) on delete set null,
  event_type text not null check (event_type in (
    'warning_scheduled', 'warning_sent', 'warning_send_failed',
    'deletion_cancelled_by_login', 'account_deleted', 'deletion_failed'
  )),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_retention_events_user on account_retention_events(user_id);
create index if not exists idx_retention_events_created on account_retention_events(created_at desc);

-- Zaai Gebruiksvoorwaarden v0.3 -- letterlijk overgenomen uit
-- Doelenboom_Gebruiksvoorwaarden_v0.3.docx, geen enkel woord aangepast
-- (inclusief het document z'n eigen "concept, nog juridisch te toetsen"-
-- voorbehoud, dat bewust onderdeel is van de getoonde tekst). Status 'draft'
-- (i.p.v. 'published'): de tekst zelf is nog geen door een jurist getoetste,
-- definitieve versie (zie Gebruiksvoorwaarden headertekst "Conceptversie 0.3"
-- en de lijst "Openstaande punten voor versie 1.0" onderaan de tekst) en is
-- daarom bewust nog niet bindend -- getCurrentDocument toont 'm alsnog (met
-- een zichtbare conceptbanner, zie LegalPage.tsx), maar needsTermsAcceptance
-- vereist alleen acceptatie van een 'published' versie, dus er wordt nu geen
-- acceptatie afgedwongen. Zet dit pas op 'published' (met een eigen
-- published_at) zodra een juridisch getoetste versie definitief is -- zie
-- docs/juridische-documenten-en-retentie.md.
insert into legal_documents (doc_type, version, effective_date, published_at, status, content)
values ('terms', '0.3', '2026-08-30', null, 'draft', $doc$
Eigenaar: Code072.nl
Status: Concept – voor juridische toetsing
Datum: 30 augustus 2026
Documentenset: Gebruiksvoorwaarden; afzonderlijke privacyverklaring volgt

DOELENBOOM
Gebruiksvoorwaarden
Conceptversie 0.3

Werkdocument. Laat de definitieve voorwaarden vóór publicatie juridisch toetsen.

Deze conceptvoorwaarden zijn opgesteld voor de applicatie Doelenboom. Code072.nl is eigenaar van Doelenboom en is voornemens zich bij de Kamer van Koophandel te registreren als startende organisatie. Na registratie moeten de definitieve handelsnaam/rechtsvorm, het KvK-nummer, vestigingsadres en eventuele btw-gegevens worden toegevoegd. De aansprakelijkheid is in dit concept zo vergaand mogelijk uitgesloten, steeds voor zover dat onder dwingend Nederlands recht is toegestaan.

## 1. Algemeen
Deze gebruiksvoorwaarden zijn van toepassing op het gebruik van de applicatie Doelenboom en de daarbij behorende diensten die door Code072.nl beschikbaar worden gesteld.
Doelenboom is een applicatie waarmee organisaties doelen, resultaten, benefits, activiteiten, projecten en andere elementen kunnen vastleggen en de onderlinge relaties tussen deze elementen inzichtelijk kunnen maken.
Door gebruik te maken van Doelenboom gaat de gebruiker akkoord met deze gebruiksvoorwaarden.
Waar in deze voorwaarden wordt gesproken over organisatie, wordt bedoeld de organisatie waarvoor een omgeving binnen Doelenboom beschikbaar is gesteld. Onder gebruiker wordt verstaan iedere persoon die namens of met toestemming van een organisatie toegang heeft tot Doelenboom.

## 2. Doel en aard van Doelenboom
Doelenboom ondersteunt organisaties bij het structureren, vastleggen en visualiseren van doelen en de relaties tussen verschillende onderdelen van een organisatie, programma, portfolio of project.
De applicatie is uitsluitend een ondersteunend hulpmiddel voor analyse, communicatie, monitoring en besluitvorming. Doelenboom neemt geen besluiten namens de gebruiker of organisatie en de uitkomsten van Doelenboom gelden niet als zelfstandig advies.
De organisatie en de gebruiker blijven te allen tijde verantwoordelijk voor de interpretatie van de opgenomen informatie en voor alle beoordelingen, conclusies, keuzes, handelingen en besluiten die geheel of gedeeltelijk op deze informatie worden gebaseerd.

## 3. Toegang en gebruiksrecht
De organisatie krijgt gedurende de looptijd van de overeenkomst een niet-exclusief en niet-overdraagbaar recht om Doelenboom te gebruiken voor de eigen bedrijfs- of organisatiedoeleinden.
Het gebruiksrecht omvat uitsluitend de functionaliteiten die binnen de overeengekomen omgeving en het gekozen abonnement of de gemaakte afspraken beschikbaar zijn.
Zonder voorafgaande toestemming van Code072.nl is het niet toegestaan toegang tot Doelenboom aan derden te verkopen of commercieel beschikbaar te stellen, de applicatie geheel of gedeeltelijk te kopiëren anders dan voor zover wettelijk toegestaan, de broncode of technische werking door reverse engineering te achterhalen voor zover een verbod wettelijk is toegestaan, beveiligingsmaatregelen te omzeilen of Doelenboom te gebruiken op een wijze die de werking of beveiliging kan verstoren.

## 4. Gebruikersaccounts en autorisaties
Toegang tot Doelenboom vindt plaats via persoonlijke gebruikersaccounts. Een gebruikersaccount mag uitsluitend worden gebruikt door de persoon aan wie het account is verstrekt.
Gebruikers zijn verantwoordelijk voor het zorgvuldig omgaan met hun toegangsgegevens. De organisatie bepaalt welke personen toegang krijgen tot haar omgeving en welke rechten of rollen aan deze personen worden toegekend.
De organisatie is verantwoordelijk voor het tijdig aanpassen of intrekken van toegangsrechten wanneer deze niet langer noodzakelijk zijn. Vermoedens van misbruik of ongeautoriseerde toegang dienen zo spoedig mogelijk te worden gemeld.

### 4.1 Inactieve gebruikersaccounts
Een gebruikersaccount dat gedurende een aaneengesloten periode van twaalf (12) maanden niet is gebruikt, wordt door Code072.nl automatisch verwijderd.
Voor het bepalen van de periode van inactiviteit wordt uitgegaan van de laatste succesvolle aanmelding van de gebruiker of, indien binnen Doelenboom een andere betrouwbare registratie van relevant gebruik wordt gehanteerd, het laatst geregistreerde relevante gebruik.
Code072.nl stuurt, voor zover het bij het gebruikersaccount geregistreerde e-mailadres bereikbaar is, circa dertig (30) dagen vóór de geplande verwijdering een waarschuwing per e-mail. De gebruiker wordt hiermee geïnformeerd dat het account wegens langdurige inactiviteit zal worden verwijderd en op welke datum de verwijdering is voorzien.
Wanneer de gebruiker vóór de aangekondigde verwijderdatum opnieuw succesvol inlogt op Doelenboom, wordt het account niet wegens inactiviteit verwijderd en begint de periode van twaalf (12) maanden opnieuw.
Het niet ontvangen, afleveren, openen of lezen van de waarschuwing voorkomt de automatische verwijdering niet. De gebruiker is zelf verantwoordelijk voor het actueel houden van het aan het account gekoppelde e-mailadres.
Na verwijdering van een inactief gebruikersaccount kan de gebruiker niet langer met dit account inloggen. Indien opnieuw toegang tot Doelenboom nodig is, dient een nieuw account te worden aangemaakt of verstrekt.
Het verwijderen van een individueel gebruikersaccount betekent niet automatisch dat gegevens die de gebruiker namens een organisatie in Doelenboom heeft vastgelegd worden verwijderd. Deze gegevens kunnen onderdeel zijn van de gegevens van de organisatie en blijven in dat geval binnen de omgeving van de organisatie beschikbaar.
Persoonsgegevens die uitsluitend noodzakelijk waren voor het verwijderde gebruikersaccount worden verwijderd of geanonimiseerd, tenzij Code072.nl deze gegevens op grond van een wettelijke verplichting of een ander gerechtvaardigd doel langer dient te bewaren.

## 5. Gegevens van de organisatie
De gegevens die een organisatie of haar gebruikers in Doelenboom invoeren, blijven van de organisatie of de oorspronkelijke rechthebbende. Het gebruik van Doelenboom leidt niet tot overdracht van eigendomsrechten op deze gegevens aan Code072.nl.
Code072.nl mag deze gegevens verwerken voor zover dit noodzakelijk is voor het beschikbaar stellen, beveiligen, beheren en ondersteunen van Doelenboom, het maken van technische back-ups, het oplossen van storingen en het voldoen aan wettelijke verplichtingen.
De organisatie is verantwoordelijk voor de inhoud, juistheid, actualiteit en rechtmatigheid van de gegevens die zij in Doelenboom vastlegt.

## 6. Vertrouwelijkheid
Code072.nl behandelt informatie van organisaties vertrouwelijk en stelt deze niet beschikbaar aan andere organisaties of derden, tenzij dit noodzakelijk is voor de uitvoering van de dienstverlening, de organisatie hiervoor toestemming heeft gegeven of Code072.nl hiertoe wettelijk verplicht is.
Personen die voor technisch beheer of ondersteuning toegang tot klantgegevens nodig hebben, krijgen uitsluitend toegang voor zover dit noodzakelijk is voor hun werkzaamheden.
De organisatie blijft verantwoordelijk voor de beoordeling welke informatie binnen Doelenboom mag worden opgeslagen.

## 7. Persoonsgegevens en privacy
Bij het gebruik van Doelenboom kunnen persoonsgegevens worden verwerkt, waaronder bijvoorbeeld namen, zakelijke e-mailadressen, gebruikersrollen en technische gebruiks- en logininformatie.
Persoonsgegevens worden verwerkt overeenkomstig de toepasselijke privacywetgeving, waaronder de Algemene Verordening Gegevensbescherming (AVG).
Code072.nl publiceert voor Doelenboom een afzonderlijke privacyverklaring. In deze privacyverklaring wordt onder meer beschreven hoe wordt omgegaan met inactieve accounts, de waarschuwing voorafgaand aan verwijdering en het verwijderen of anonimiseren van accountgebonden persoonsgegevens.
Wanneer Code072.nl namens een organisatie persoonsgegevens verwerkt waarvoor die organisatie verwerkingsverantwoordelijke is, kunnen aanvullende afspraken worden vastgelegd in een verwerkersovereenkomst.

## 8. Informatiebeveiliging
Code072.nl treft passende technische en organisatorische maatregelen om Doelenboom en de daarin opgeslagen gegevens te beschermen tegen verlies, onbevoegde toegang, ongeoorloofde wijziging en andere vormen van onrechtmatige verwerking.
Geen enkel digitaal systeem kan volledige beveiliging of ononderbroken beschikbaarheid garanderen. Gebruikers en organisaties hebben daarom een eigen verantwoordelijkheid voor veilig gebruik, waaronder het beschermen van accounts en het zorgvuldig toekennen van autorisaties.
Het is niet toegestaan informatie in Doelenboom op te slaan waarvoor op grond van wetgeving, interne regelgeving of beveiligingsclassificatie een hoger beveiligingsniveau is vereist dan door Doelenboom wordt geboden, tenzij hierover vooraf uitdrukkelijke afspraken zijn gemaakt.

## 9. Beschikbaarheid, onderhoud en wijzigingen
Code072.nl streeft naar een zo hoog mogelijke beschikbaarheid en betrouwbare werking van Doelenboom, maar geeft geen garantie op ononderbroken of foutloze beschikbaarheid, tenzij hierover schriftelijk andere afspraken zijn gemaakt.
Doelenboom kan tijdelijk geheel of gedeeltelijk buiten gebruik worden gesteld voor onderhoud, beveiligingsupdates, verbeteringen of andere technische werkzaamheden. Waar redelijkerwijs mogelijk wordt gepland onderhoud vooraf aangekondigd.
Code072.nl mag Doelenboom aanpassen en verder ontwikkelen. Specifieke afspraken over beschikbaarheid, hersteltijden of ondersteuning kunnen afzonderlijk in een Service Level Agreement (SLA) worden vastgelegd.

## 10. Back-up en herstel
Code072.nl kan technische back-ups maken om herstel van de dienst na technische incidenten mogelijk te maken. Back-ups vormen niet automatisch een archiefvoorziening voor individuele gebruikers of organisaties.
De organisatie blijft verantwoordelijk voor gegevens die zij op grond van wet- of regelgeving zelfstandig dient te bewaren of archiveren.

## 11. Export van gegevens
De organisatie moet haar eigen gegevens binnen redelijke grenzen kunnen meenemen wanneer zij het gebruik van Doelenboom beëindigt. Voor zover de beschikbare functionaliteit dit ondersteunt, kunnen gegevens worden geëxporteerd in een gangbaar formaat.
Indien een volledige export niet via de applicatie beschikbaar is, kunnen hierover afzonderlijke afspraken worden gemaakt.

## 12. Beëindiging en verwijderen van gegevens
Na beëindiging van de overeenkomst wordt de toegang van de organisatie en haar gebruikers beëindigd. Tenzij anders overeengekomen krijgt de organisatie gedurende een redelijke termijn gelegenheid haar gegevens te exporteren.
Na het verstrijken van deze termijn mogen de gegevens uit de actieve systemen worden verwijderd. Gegevens kunnen gedurende een beperkte periode nog in technische back-ups aanwezig zijn en worden volgens het geldende back-up- en retentiebeleid verwijderd.

## 13. Intellectueel eigendom
Code072.nl is eigenaar van Doelenboom. Alle intellectuele eigendomsrechten op Doelenboom, waaronder de software, broncode, vormgeving, technische componenten, documentatie en andere door Code072.nl ontwikkelde onderdelen, blijven bij Code072.nl of diens eventuele licentiegevers.
De organisatie verkrijgt uitsluitend het in deze voorwaarden beschreven gebruiksrecht. Gegevens en inhoud die door de organisatie zelf in Doelenboom worden ingebracht, blijven van de organisatie of de betreffende rechthebbende.

## 14. Verboden gebruik
Het is niet toegestaan Doelenboom te gebruiken voor activiteiten die in strijd zijn met wet- of regelgeving, voor het verspreiden of opslaan van malware, voor ongeautoriseerde toegang tot systemen of gegevens, voor het zonder toestemming testen of omzeilen van beveiligingsmaatregelen, voor activiteiten die de werking voor andere gebruikers verstoren of voor het verwerken van gegevens waarvoor geen rechtmatige grondslag bestaat.
Bij ernstig of herhaald misbruik kan Code072.nl de toegang tijdelijk opschorten of beëindigen.

## 15. Ondersteuning
Code072.nl kan ondersteuning bieden bij technische vragen over het gebruik van Doelenboom. Tenzij uitdrukkelijk anders overeengekomen, omvat deze ondersteuning geen inhoudelijk organisatie-, programma-, portfolio-, management-, juridisch of ander professioneel advies.
Advies over het ontwerpen, inrichten of beoordelen van een doelenboom kan als afzonderlijke dienstverlening worden aangeboden.

## 16. Aansprakelijkheid en gebruik voor eigen risico
Het gebruik van Doelenboom geschiedt volledig voor rekening en risico van de organisatie en de gebruiker.
Doelenboom is uitsluitend een hulpmiddel voor het vastleggen, structureren, visualiseren en analyseren van door gebruikers ingevoerde informatie en de relaties tussen deze informatie. Doelenboom verstrekt geen zelfstandig organisatorisch, bedrijfskundig, financieel, juridisch of ander professioneel advies.
Code072.nl is niet verantwoordelijk voor de inhoud, juistheid, volledigheid, actualiteit of geschiktheid van gegevens die in Doelenboom worden opgenomen, noch voor de wijze waarop deze gegevens, relaties, visualisaties, analyses of andere resultaten worden geïnterpreteerd of gebruikt.
De organisatie en de gebruiker blijven te allen tijde volledig verantwoordelijk voor alle beoordelingen, conclusies, keuzes, handelingen en besluiten die geheel of gedeeltelijk worden gebaseerd op informatie uit Doelenboom.
Voor zover wettelijk toegestaan, is Code072.nl niet aansprakelijk voor enige schade die direct of indirect voortvloeit uit of verband houdt met het gebruik, de onmogelijkheid tot gebruik, de beschikbaarheid, tijdelijke onbeschikbaarheid, werking of resultaten van Doelenboom.
Deze uitsluiting omvat, voor zover wettelijk toegestaan, onder meer directe en indirecte schade, gevolgschade, bedrijfsschade, verlies van inkomsten of winst, verlies van gegevens, gemiste besparingen, reputatieschade en schade als gevolg van beslissingen die mede op basis van Doelenboom zijn genomen.
Code072.nl geeft geen garantie dat Doelenboom te allen tijde foutloos, volledig, ononderbroken of zonder verlies van gegevens beschikbaar zal zijn.
Geen bepaling in deze voorwaarden beperkt of sluit aansprakelijkheid uit voor zover een dergelijke beperking of uitsluiting op grond van dwingend Nederlands recht niet is toegestaan.

## 17. Overmacht
Code072.nl is niet aansprakelijk voor het niet of niet tijdig nakomen van verplichtingen wanneer dit het gevolg is van omstandigheden waarop Code072.nl redelijkerwijs geen invloed kan uitoefenen, waaronder storingen bij internet- of hostingproviders, grootschalige netwerkstoringen, cyberincidenten, stroomstoringen, overheidsmaatregelen en andere vormen van overmacht.

## 18. Duur, opschorting en beëindiging
De duur en wijze van beëindiging van het gebruik van Doelenboom worden vastgelegd in de overeenkomst of het abonnement met de organisatie.
Code072.nl kan de toegang tijdelijk opschorten wanneer dit noodzakelijk is vanwege een ernstig beveiligingsrisico, aantoonbaar misbruik, overtreding van deze voorwaarden, het niet nakomen van betalingsverplichtingen of een wettelijke verplichting. Waar redelijkerwijs mogelijk wordt de organisatie vooraf geïnformeerd.

## 19. Kosten en betaling
Indien voor het gebruik van Doelenboom kosten verschuldigd zijn, worden de prijs, abonnementsvorm, factureringsperiode en eventuele aanvullende diensten vastgelegd in de overeenkomst, offerte of abonnementsbevestiging.
Tenzij anders vermeld zijn bedragen exclusief btw. Code072.nl kan tarieven wijzigen; materiële prijswijzigingen bij lopende abonnementen worden vooraf aangekondigd overeenkomstig de gemaakte afspraken.

## 20. Wijziging van deze voorwaarden
Code072.nl kan deze gebruiksvoorwaarden wijzigen wanneer ontwikkelingen in Doelenboom, wet- en regelgeving of de dienstverlening daartoe aanleiding geven. Materiële wijzigingen worden vooraf bekendgemaakt.
De meest recente versie van de voorwaarden wordt beschikbaar gesteld via Doelenboom of de bijbehorende website.

## 21. Toepasselijk recht en geschillen
Op het gebruik van Doelenboom en deze gebruiksvoorwaarden is Nederlands recht van toepassing.
Partijen zullen proberen eventuele geschillen eerst in onderling overleg op te lossen. Indien dit niet mogelijk blijkt, wordt het geschil voorgelegd aan de bevoegde rechter in Nederland, tenzij dwingend recht anders bepaalt.

## 22. Aanvullende documenten
Deze gebruiksvoorwaarden kunnen onderdeel vormen van een bredere set afspraken. Afhankelijk van de dienstverlening kunnen daarnaast een overeenkomst, offerte of abonnementsbevestiging, de privacyverklaring van Doelenboom, een verwerkersovereenkomst, een Service Level Agreement (SLA) en aanvullende afspraken over informatiebeveiliging van toepassing zijn.
Bij tegenstrijdigheden tussen documenten geldt de rangorde zoals opgenomen in de overeenkomst met de organisatie.

## Openstaande punten vóór versie 1.0
- Definitieve juridische entiteit/handelsnaam van Code072.nl na KvK-registratie.
- KvK-nummer, vestigingsadres en eventuele btw-gegevens.
- Definitieve abonnements- en betalingsvoorwaarden.
- Concrete bewaartermijn na beëindiging van een organisatieomgeving en retentie van back-ups.
- Hostinglocatie en eventuele subverwerkers.
- Beveiligingsniveau en welke categorieën gegevens wel/niet mogen worden opgeslagen.
- Opstellen en publiceren van de afzonderlijke privacyverklaring, inclusief de 12-maandentermijn en waarschuwing circa 30 dagen vooraf.
- Beoordelen of voor zakelijke klanten een verwerkersovereenkomst nodig is.
- Juridische toets van de aansprakelijkheidsuitsluiting en de volledige voorwaarden vóór publicatie.
$doc$)
on conflict (doc_type, version) do nothing;

-- Privacyverklaring: er bestaat op dit moment nog geen door de opdrachtgever
-- aangeleverde/goedgekeurde privacytekst (zie §3 van de featureopdracht --
-- "gebruik een duidelijke concept/placeholder-status, verzin geen
-- privacytekst"). Dit is dus BEWUST geen echte privacyverklaring, maar een
-- expliciet gelabelde placeholder-rij (status 'draft', nooit 'published')
-- zodat GET /api/legal/privacy een duidelijk shown-as-concept-pagina
-- oplevert i.p.v. een kale 404 -- zie legal.ts getCurrentDocument (valt bij
-- geen gepubliceerde versie terug op de meest recente draft) en
-- LegalPage.tsx (toont de oranje conceptbanner zolang status != 'published').
insert into legal_documents (doc_type, version, effective_date, published_at, status, content)
values ('privacy', '0.1', '2026-08-30', null, 'draft', $doc$
Status: Concept -- nog niet vastgesteld

De privacyverklaring van Doelenboom is op dit moment nog niet opgesteld en dus nog niet inhoudelijk beschikbaar. Deze pagina is een placeholder totdat Code072.nl de definitieve privacyverklaring heeft opgesteld, juridisch heeft laten toetsen en heeft gepubliceerd.

Zodra de privacyverklaring beschikbaar is, verschijnt de volledige tekst op deze plek, met een eigen versienummer en ingangsdatum.
$doc$)
on conflict (doc_type, version) do nothing;


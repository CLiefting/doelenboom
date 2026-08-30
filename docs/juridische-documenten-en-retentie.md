# Gebruiksvoorwaarden, privacyverklaring en accountretentie

Dit document beschrijft de architectuur achter drie samenhangende
onderdelen: gepubliceerde juridische documenten (gebruiksvoorwaarden en
privacyverklaring), de server-side registratie van acceptatie daarvan, en de
automatische verwijdering van 12+ maanden inactieve gebruikersaccounts. Zie
ook `db/migrations/0017_legal_and_retention.sql` (schema + zaaidata) en de
brontekst `Doelenboom_Gebruiksvoorwaarden_v0.3.docx`.

**Status van de tekst zelf**: de gepubliceerde gebruiksvoorwaarden zijn
letterlijk overgenomen uit het door de opdrachtgever aangeleverde
Word-document — geen woord aangepast, inclusief het document z'n eigen
"concept, nog juridisch te toetsen"-voorbehoud en de lijst "Openstaande
punten vóór versie 1.0" onderaan de tekst zelf. De privacyverklaring is nog
niet aangeleverd/goedgekeurd en staat daarom als expliciet gelabelde
conceptplaceholder in de database (status `draft`, nooit `published`) — er
is bewust geen privacytekst verzonnen.

## 1. Datamodel

Drie nieuwe tabellen, plus drie nieuwe kolommen op `users` (zie migratie
0017 voor de volledige `create table`/`alter table`-statements).

### `legal_documents`

Eén rij per versie van één documenttype (`doc_type`: `'terms'` of
`'privacy'`). Velden: `version`, `effective_date`, `published_at`,
`status` (`'draft'` of `'published'`), `requires_reacceptance` (default
`true`), `content` (platte tekst in een lichte, zelfbedachte
Markdown-achtige conventie — zie §2), met `unique (doc_type, version)`.
Oudere versies worden nooit verwijderd of overschreven: elke publicatie is
een nieuwe rij, zodat de volledige historie (welke tekst gold wanneer)
bewaard blijft.

### `legal_acceptances`

Eén rij per (gebruiker, documentversie) — `unique (user_id,
legal_document_id)`. `user_id` cascadeert bij verwijdering van de gebruiker
(de acceptatie zelf heeft geen waarde meer zonder de gebruiker);
`legal_document_id` is `on delete restrict` (een documentversie die ooit
geaccepteerd is, mag niet zomaar verdwijnen). Dit is de enige bron van
waarheid voor "heeft gebruiker X versie Y geaccepteerd" — er wordt nergens
op frontend-state, cookies of localStorage vertrouwd (zie §3).

### `account_retention_events`

Auditlog voor de volledige retentie-levenscyclus — zelfde patroon als het
bestaande `license_events` (migratie 0015): `user_id` is `on delete set
null`, zodat een gebeurtenis als "account verwijderd wegens inactiviteit"
zelf overleeft als anoniem historisch record nadat de gebruiker in dezelfde
sweep daadwerkelijk verwijderd wordt. `event_type` is een vaste enumeratie
(`warning_scheduled`, `warning_sent`, `warning_send_failed`,
`deletion_cancelled_by_login`, `account_deleted`, `deletion_failed`),
`detail` is een kleine jsonb (bewust geminimaliseerd — zie §7: alleen
e-mailadres en reden, geen verdere persoonsgegevens).

### Nieuwe kolommen op `users`

`last_login_at`, `inactivity_warning_sent_at`, `scheduled_deletion_at`
(alle `timestamptz`, nullable). Zie §5 voor de betekenis van elk veld.

## 2. Contentconventie en rendering

`legal_documents.content` gebruikt een lichte, zelfbedachte
Markdown-achtige conventie in plaats van een externe Markdown-library: `##
` opent een paragraafkop (H2), `### ` een subkop (H3), `- ` een
opsommingsitem, een lege regel scheidt alinea's, en al het overige is platte
alinea-tekst (regels binnen dezelfde alinea worden met een spatie aan elkaar
geplakt — zo blijft de brontekst zelf onveranderd, dit is puur
weergavevorm). `web/src/pages/LegalPage.tsx` bevat een kleine
regel-voor-regel renderer voor deze conventie.

## 3. Publieke pagina en acceptatie-UI

- `GET /api/legal/:type` (`terms`/`privacy`, publiek, geen token) geeft het
  meest relevante document terug: bij voorkeur de meest recente
  `published`-versie, anders (voor `privacy`, dat nog geen gepubliceerde
  versie heeft) de meest recente `draft` — zodat de pagina nooit leeg is en
  altijd laat zien of het om een concept gaat (`status`-veld,
  `LegalPage.tsx` toont dan een oranje conceptbanner).
- `LegalPage.tsx` is een losstaande, publiek bereikbare React-pagina (geen
  inlogscherm-modal met een klein scrollvak) met een duidelijke H1/H2-
  hiërarchie en een beperkte leesbreedte. Bereikbaar vanaf elk scherm, ook
  vóór inloggen, via twee kleine linkjes in `VersionFooter.tsx` (zichtbaar op
  elk scherm, inclusief de boomweergave) en vanaf het inlogscherm zelf
  (`LoginPage.tsx`).
- `TermsAcceptanceGate.tsx` blokkeert de rest van de app zolang
  `session.user.termsAcceptanceRequired` true is — hetzelfde patroon als de
  bestaande `mustChangePassword`-afgedwongen-wachtwoordwijziging in
  `App.tsx`, ná die gate (een tijdelijk wachtwoord moet sowieso eerst
  vervangen worden). De checkbox ("Ik ga akkoord met de
  Gebruiksvoorwaarden") staat nooit vooraf aangevinkt, en
  "Gebruiksvoorwaarden" is zelf een klikbare link naar de volledige tekst
  (`LegalPage`, inline getoond zodat de acceptatiecontext niet verloren
  gaat).
- De daadwerkelijke acceptatie wordt altijd server-side geregistreerd op
  basis van het token: `POST /api/legal/terms/accept` leest uitsluitend
  `req.user!.id`, nooit een `userId`/`user_id` uit de request body — een
  gebruiker kan dus nooit acceptatie namens een andere gebruiker
  registreren (getest in `api/test/legal.test.ts`).

## 4. Wanneer is heracceptatie nodig?

`needsTermsAcceptance(userId)` (`api/src/legal.ts`) is de enige plek waar
dit wordt bepaald:

1. Bestaat er nog geen gepubliceerde `terms`-versie? → geen blokkade (er
   valt niets te accepteren).
2. Heeft deze gebruiker de huidige versie al geaccepteerd? → geen blokkade.
3. Is dit niet de eerste versie, heeft de gebruiker een oudere versie al
   geaccepteerd, én is `requires_reacceptance` van de huidige versie
   `false`? → geen blokkade (bestaand gebruik blijft ongemoeid).
4. In alle andere gevallen → blokkade.

`requires_reacceptance` is dus de knop waarmee een publicatie bepaalt of
bestaande gebruikers opnieuw moeten accepteren (bv. bij een materiële
wijziging) of niet (bv. een tekstuele correctie zonder inhoudelijke
wijziging).

## 5. Inactiviteitsbeleid: definities en constanten

Alle beleidswaarden staan als benoemde constanten in
`api/src/accountRetention.ts` — nergens los in de code als magic number:

```ts
export const ACCOUNT_INACTIVITY_MONTHS = 12;
export const ACCOUNT_DELETION_WARNING_DAYS = 30;
```

**Gekozen definitie van "relevant gebruik"**: `users.last_login_at`, gezet
bij elke geslaagde `POST /api/auth/login` (`api/src/auth.ts`). Bewust *niet*
`sessions.last_seen_at` (blinde per-minuut heartbeat, verdwijnt bij
afmelden) of `sessions.last_activity_at` (de bestaande 15-minuten-
inactiviteit-uitlogbeveiliging binnen één sessie, `IDLE_TIMEOUT_MINUTES` in
`auth.ts`) — beide zijn per-sessie en vluchtig, en zeggen niets over of een
account nog in gebruik is. `last_login_at` is een duurzaam, per-gebruiker
veld dat precies aansluit bij Gebruiksvoorwaarden §4.1 ("de laatste
succesvolle aanmelding van de gebruiker"). Deze technische keuze moet in
lijn blijven met wat de gepubliceerde voorwaarden beschrijven — wijzig
`ACCOUNT_INACTIVITY_MONTHS`/`ACCOUNT_DELETION_WARNING_DAYS` dus nooit los
van een bijbehorende aanpassing van de gepubliceerde tekst.

Accounts die nog nooit zijn ingelogd (`last_login_at is null`) worden door
de sweep bewust overgeslagen — er is geen "relevant gebruik" om vanaf te
meten.

## 6. Waarschuwings- en verwijderflow

`sweepAccountRetention()` (`api/src/accountRetention.ts`) bestaat uit twee
idempotente stappen, uitgevoerd bij elke sweep:

1. **`scheduleWarnings()`** — gebruikers met `last_login_at` ouder dan
   `ACCOUNT_INACTIVITY_MONTHS - ACCOUNT_DELETION_WARNING_DAYS` én nog geen
   `scheduled_deletion_at` krijgen `scheduled_deletion_at = now() +
   ACCOUNT_DELETION_WARNING_DAYS dagen` en `inactivity_warning_sent_at =
   now()`. De `scheduled_deletion_at is null`-voorwaarde maakt dit
   idempotent: een tweede sweep verschuift een al geplande verwijderdatum
   nooit opnieuw naar voren. Elke stap wordt gelogd
   (`warning_scheduled`).
2. **`sendInactivityWarning()`** — verstuurt (op dit moment: logt alleen,
   zie §8) de waarschuwingsmail en logt `warning_sent`/
   `warning_send_failed`. Een falende verzending gooit nooit een
   onafgehandelde fout: die mag de sweep, en zeker de latere automatische
   verwijdering, nooit blokkeren (het niet ontvangen/lezen van de
   waarschuwing voorkomt de verwijdering niet — Gebruiksvoorwaarden §4.1).
3. **`deleteExpiredAccounts()`** — gebruikers met een verstreken
   `scheduled_deletion_at` worden daadwerkelijk verwijderd, via exact
   dezelfde `delete from users where id = $1` als het bestaande handmatige
   `DELETE /api/users/:id` (`routes/users.ts`) — zie §7 voor waarom dat
   veilig is voor organisatie-inhoud. Vóór de delete wordt, als het om een
   sysadmin gaat, dezelfde "minstens één sysadmin moet overblijven"-
   bescherming toegepast als in `routes/users.ts`: is dit de laatste
   sysadmin, dan wordt de verwijdering overgeslagen en gelogd
   (`deletion_failed`, reden `laatste-sysadmin-zou-overblijven`) in plaats
   van hard te falen. Bij een succesvolle verwijdering wordt eerst
   `account_deleted` gelogd (met het e-mailadres in `detail`, want
   `user_id` wordt door de `on delete set null`-FK ná de delete zelf leeg).

**Inloggen annuleert altijd**: `POST /api/auth/login` zet bij elke
geslaagde login `last_login_at = now()` én `scheduled_deletion_at =
null, inactivity_warning_sent_at = null` — ongeacht of er al een
waarschuwing/verwijdering gepland stond. Stond er een geplande verwijdering
klaar, dan wordt dat expliciet gelogd als `deletion_cancelled_by_login`.
Dit start de 12-maanden-klok volledig opnieuw (Gebruiksvoorwaarden §4.1).

## 7. Waarom organisatie-inhoud gegarandeerd intact blijft

Vóór implementatie is elke `references users(id)` in `db/init.sql` en
`db/migrations/*.sql` doorgelicht. Precies drie tabellen cascaderen op
`users.id`: `sessions`, `tenant_users`, `doelenboom_user_roles` — stuk voor
stuk pure toegangs-/sessie-/lidmaatschapsrecords van dát ene account. Geen
enkele tabel met organisatie-inhoud (`doelenbomen`, `elements`, `edges`,
`products`, `activities`, `tags`, `org_units`, project-status, imports,
...) heeft ooit een foreign key naar `users` gehad (geen `created_by`/
`updated_by`-koppeling) — die inhoud hangt uitsluitend aan de `tenant`/
`doelenboom`, nooit aan een individueel gebruikersaccount. Het verwijderen
van een los account kan dus structureel nooit organisatie-inhoud
meenemen: er is geen aanvullend beschermingsmechanisme nodig, alleen
hergebruik van de al bewezen veilige delete-statement uit
`routes/users.ts`. Dit is expliciet getest in
`api/test/accountRetention.test.ts` ("... laat de tenant en de doelenboom
... volledig intact").

Omdat er nergens een `created_by`/`updated_by`-verwijzing naar `users`
bestaat, is er ook geen "toon anoniem/verwijderde gebruiker"-mechanisme
nodig om historische betekenis te bewaren — er is simpelweg niets dat naar
het verwijderde account verwijst buiten de retentie-auditlog zelf (§6/§9),
die daar met `on delete set null` al specifiek voor is ingericht.

## 8. E-mailverzending (bewust: nu alleen loggen)

Er bestaat op dit moment nergens in dit project een mailprovider (geen
SMTP/nodemailer/sendgrid/mailgun/postmark, geen mail-gerelateerde
env-variabelen). In overleg met de opdrachtgever is expliciet gekozen om de
volledige waarschuwings-/auditlogica nu al te bouwen, met
`sendInactivityWarning()` als geïsoleerde, makkelijk vervangbare stub die
alleen naar de serverconsole logt (`console.log`) en een `warning_sent`-
event registreert. Zodra een echte provider wordt gekozen, verandert
uitsluitend de inhoud van die ene functie — de planning, idempotentie,
annulering-bij-login en auditlogging blijven ongewijzigd.

## 9. Dataminimalisatie in de auditlog

`account_retention_events.detail` bevat bewust alleen wat nodig is om de
gebeurtenis te kunnen begrijpen (e-mailadres, reden) — geen wachtwoord-hash,
geen sessie-inhoud, geen overige accountvelden. Na de daadwerkelijke
verwijdering blijft alleen deze geminimaliseerde auditlog over als bewijs
dat een account is verwijderd; alle overige persoonsgegevens van het account
zelf (e-mailadres, wachtwoord-hash, sessies, tenant-lidmaatschappen) zijn
dan al weg via de `delete from users`/cascades.

## 10. Invalidatie van toegang bij verwijdering

Doordat `sessions` cascadeert op `users.id`, verdwijnen bij het verwijderen
van een account automatisch al zijn sessies — een bestaande JWT voor dat
account faalt vanaf dat moment altijd op `requireAuth` (de sessies-rij
bestaat niet meer, zie `auth.ts`). Er bestaan in dit project (nog) geen
aparte refresh-tokens, API-tokens, wachtwoord-reset-tokens, magic links of
MFA-secrets — mocht een van die mechanismen ooit worden toegevoegd, dan moet
de tabel die ze opslaat op dezelfde manier cascaderen op `users.id`.

## 11. Scheduler

Eén extra `setInterval` in `api/src/index.ts`, naast de bestaande
idle-sweep (`sweepIdleTenants`) — zelfde in-process patroon, voldoende voor
dit project (v1, één container, geen horizontale schaling), geen aparte
scheduler/cron nodig:

```ts
const ACCOUNT_RETENTION_SWEEP_INTERVAL_MS = 60 * 60_000; // 1x per uur
setInterval(() => {
  sweepAccountRetention().catch((err) => {
    console.error('Accountretentie-sweep mislukt:', err);
  });
}, ACCOUNT_RETENTION_SWEEP_INTERVAL_MS);
```

Elke stap is idempotent (zie §6), dus vaker draaien dan strikt nodig voor
een dag-granulair beleid is onschadelijk — het zorgt er vooral voor dat een
gemiste run (bv. door een herstart) snel wordt ingehaald.

## 12. Configuratie-overzicht

| Constante | Waarde | Locatie |
|---|---|---|
| `ACCOUNT_INACTIVITY_MONTHS` | 12 | `api/src/accountRetention.ts` |
| `ACCOUNT_DELETION_WARNING_DAYS` | 30 | `api/src/accountRetention.ts` |
| `ACCOUNT_RETENTION_SWEEP_INTERVAL_MS` | 1 uur | `api/src/index.ts` |

## 13. Tests

- `api/test/legal.test.ts` — publicatie/statuslogica, acceptatie (incl.
  idempotentie, gebruiker-isolatie, `requires_reacceptance` aan/uit,
  bewaarde historie, 409 zonder gepubliceerde versie).
- `api/test/accountRetention.test.ts` — waarschuwingsplanning, idempotentie,
  daadwerkelijke verwijdering, behoud van organisatie-inhoud, de
  laatste-sysadmin-bescherming, annulering-bij-login (met en zonder
  auditevent), en dat een mislukte login niets aanraakt.

## 14. Acceptatiecriteria ("wanneer is dit klaar?")

- [x] De letterlijke Gebruiksvoorwaarden v0.3-tekst is ongewijzigd
      gepubliceerd en publiek bereikbaar (`GET /api/legal/terms`,
      `LegalPage.tsx`).
- [x] De privacyverklaring is een duidelijk gelabelde conceptplaceholder,
      geen verzonnen tekst.
- [x] Versiebeheer (`version`, `effective_date`, `status`,
      `requires_reacceptance`) is aanwezig en werkt.
- [x] Acceptatie vereist een expliciete, niet-vooraf-aangevinkte checkbox
      met een klikbare link naar de volledige tekst.
- [x] Acceptatie wordt server-side, auditeerbaar (user_id, versie,
      tijdstip) geregistreerd, nooit vertrouwd op frontend-state.
- [x] Een gebruiker kan nooit namens een andere gebruiker accepteren
      (getest).
- [x] `requires_reacceptance` triggert opnieuw blokkeren bij een nieuwe
      versie; oudere acceptaties blijven bewaard.
- [x] Automatische verwijdering na 12 maanden inactiviteit, gebaseerd op
      `last_login_at`.
- [x] Waarschuwing ~30 dagen vooraf (nu log-only, makkelijk uitbreidbaar).
- [x] Login vóór de verwijderdatum annuleert volledig en herstart de klok.
- [x] Het niet ontvangen/lezen van de waarschuwing blokkeert de
      verwijdering niet.
- [x] De sweep is idempotent en veilig herhaaldelijk te draaien.
- [x] Automatische verwijdering hergebruikt de bestaande scheduler
      (`setInterval`), geen nieuw framework.
- [x] Organisatie-inhoud kan nooit verloren gaan bij het verwijderen van een
      los account (structureel gegarandeerd, zie §7).
- [x] Persoonsgegevens die alleen bij het account hoorden, zijn na
      verwijdering weg (cascade + geminimaliseerde auditlog).
- [x] Alle toegangsmiddelen van het account zijn na verwijdering ongeldig
      (sessies cascaderen weg).
- [x] De volledige levenscyclus is auditeerbaar/loggbaar.
- [x] Geen magic numbers — centrale, benoemde constanten.
- [x] Automatische tests voor beide onderdelen (≥10 resp. ≥20 scenario's).
- [x] Deze documentatie.

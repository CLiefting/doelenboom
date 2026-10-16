# Dependency-updates: werkwijze en bewust uitgestelde majors

Vastgelegd bij DOEL-48 (2 oktober 2026). Doel: de pagina **Softwarecomponenten**
moet laten zien waar actie nodig is, niet een lange lijst waarin alles
"achterstallig" lijkt.

## Hoe we bijblijven

| Wat | Hoe | Blokkeert? |
|---|---|---|
| Kwetsbaarheden in de code (npm, pip) | Workflow **Dependency-audit**: bij elke PR en dagelijks 05:17 UTC (DOEL-69) | Ja: CI rood, geen merge/release |
| Kwetsbaarheden in wat in productie draait | Dagelijkse controle in de app tegen OSV.dev; **mail aan sysadmins** bij een nieuwe bevinding met ernst hoog, kritiek of onbekend (DOEL-70) | Nee, wel melding |
| Patch- en minor-updates | **Dependabot**, wekelijks één gegroepeerde PR per onderdeel (api, web, excel-service, github-actions), 7 dagen cooldown | Nee; mergen na groene CI |
| Major-updates | Per stuk via een eigen ticket (zie hieronder) | Nee |
| Install-scripts van npm-pakketten | Alleen goedgekeurde pakketten, met vaste versie, in `allowScripts` van `package.json`; CI-stap `scripts/check-install-scripts.sh` (DOEL-118) | Ja: CI rood bij een niet-goedgekeurd install-script |

Doelenboom werkt zelf nooit automatisch dependencies bij (zie
`doelenboom_sbom_ontwerp.md`): Dependabot maakt alleen een voorstel (PR),
mergen en uitrollen blijft een bewuste handeling.

## Install-scripts: alleen na goedkeuring (DOEL-118)

Sinds npm 11.19 houdt npm per project bij welke pakketten een install-script
(`preinstall`/`install`/`postinstall`) mogen draaien: het blok `allowScripts`
in `api/package.json` en `web/package.json`. Nu goedgekeurd, met vaste versie:

| Onderdeel | Pakket | Waarom |
|---|---|---|
| api | `esbuild@0.28.2` | Haalt het platformspecifieke binaire bestand op; nodig voor `tsx`. |
| web | `esbuild@0.25.12` | Idem; nodig voor `vite`. |
| api, web | `fsevents@2.3.3` | Bestandsbewaking op macOS (optioneel; in Docker/CI op Linux niet geïnstalleerd). |

De CI-stap `scripts/check-install-scripts.sh` faalt zodra er een install-script
zonder goedkeuring binnenkomt: een nieuw pakket, of een **nieuwe versie** van een
goedgekeurd pakket (bijvoorbeeld via een Dependabot-PR die vite of tsx bijwerkt).
Dat is bewust (OWASP A08): een gekaapte nieuwe versie draait dan niet ongemerkt.

Komt er via een Dependabot-PR een nieuwe esbuild-versie binnen, dan in die PR:

```zsh
cd ~/src/doelenboom/web && npm ci && npm install-scripts ls && npm install-scripts approve esbuild
```

(of in `api`), het pakket even nalopen (release-notes, wat het script doet) en de
wijziging in `package.json` meecommitten. Haal daarbij de regel van de oude versie
uit `allowScripts` weg, zodat alleen goedkeuringen blijven staan voor versies die
echt gebruikt worden.

## Wat de pagina telt

- **Updates voor directe productie-dependencies** (patch / minor / major):
  de pakketten die wij zelf kiezen en die in productie draaien. Dit is de
  teller om op te sturen; streefwaarde voor patch en minor is 0 na de
  wekelijkse Dependabot-PR.
- **Updates totaal**: ook transitieve en ontwikkel-dependencies. Transitieve
  versies kiezen wij niet zelf; ze schuiven mee zodra de directe dependency
  of de lockfile wordt bijgewerkt. Een transitieve versie forceren
  (`overrides` in npm) doen we alleen bij een kwetsbaarheid, niet om de
  teller omlaag te krijgen.
- De componentenlijst toont standaard alleen directe productie-dependencies;
  de rest zit achter "Toon alles".

Ontwikkel-dependencies blijven bewust wél in de SBOM staan: ze draaien niet
in productie, maar horen bij de bouwketen en zijn bij een audit daarvan
relevant.

## Stand per 2 oktober 2026 (nulmeting → na DOEL-48)

Nulmeting (productie, SBOM van v3.1.3): 379 componenten, 184 updates waarvan
87 major, 4 componenten met een kwetsbaarheid.

Bijgewerkt in DOEL-48:

- api: express 4.22.3, pg 8.23.1, tsx 4.23.15, @types/multer 2.3.0,
  @types/node 24.19.1; lockfile ververst (transitieve versies binnen bereik).
- web: lockfile ververst.
- excel-service: fastapi 0.142.2, uvicorn 0.54.0, mpxj 16.9.0.

Na deze update zijn er voor directe dependencies geen patch- of minor-updates
meer open (`npm outdated`, PyPI). Wat overblijft zijn de majors hieronder.

## Bewust uitgestelde majors

| Pakket | Nu | Nieuwste | Besluit | Reden | Ticket |
|---|---|---|---|---|---|
| express (+ @types/express) | 4.22 | 5.x | Later | Gewijzigde padsyntax en foutafhandeling; raakt alle routes. Express 4 wordt nog onderhouden, geen kwetsbaarheid. | DOEL-71 |
| react, react-dom (+ types) | 18.3 | 19.x | Later | Vraagt een volledige doorloop van de beheer-app. Geen kwetsbaarheid. | DOEL-72 |
| vite, @vitejs/plugin-react | 6.4 / 4.7 | 8.x / 6.x | Later, samen met React | Twee majors tegelijk, plugin hangt aan beide. Alleen bouwgereedschap. | DOEL-72 |
| typescript | 5.9 | 7.x | Later, na de twee hierboven | Alleen ontwikkelgereedschap; kan strengere controles meebrengen. | DOEL-73 |
| @types/node | 24.x | 26.x | Niet | Hoort bij de Node-versie van de images (Node 24). Gaat mee als de images naar een nieuwe Node-LTS gaan. | — |

Een uitgestelde major die een kwetsbaarheid krijgt waarvoor alleen de nieuwe
major een fix heeft, wordt meteen opgepakt: dan gaat de dagelijkse audit
rood en volgt de mail aan de sysadmins.

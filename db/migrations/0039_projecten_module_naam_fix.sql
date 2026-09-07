-- Migratie: modulenaam "Projecten" corrigeren — het "(+20%)"-achtervoegsel
-- klopt niet meer sinds db/migrations/0038_prijsstrategie_v3.sql de
-- Projecten-opslag van een generiek 20%-percentage naar vaste bedragen per
-- tier omzette (module_tier_surcharges). Dat achtervoegsel stond nooit in
-- een migratie-seed (db/init.sql/0002_licenses.sql zaaien "Projecten", zonder
-- suffix) — het is op enig moment via het licentiecatalogus-scherm
-- (sysadmins kunnen module-naam/-omschrijving vrij bewerken, zie
-- LicenseCatalogPage.tsx) handmatig bijgewerkt tot "Projecten (+20%)" om het
-- toenmalige percentage zichtbaar te maken in de tier-/modulelijst, en is
-- sindsdien niet meer teruggedraaid.
--
-- Idempotent: de where-clausule raakt na de eerste keer gewoon 0 rijen (en
-- ook op een db waar de naam al "Projecten" was, bv. een verse installatie,
-- gebeurt er niets).
--
-- Draai dit één keer tegen een BESTAANDE database; voor VERSE installaties
-- staat dit al goed in db/init.sql.
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0039_projecten_module_naam_fix.sql

update modules set name = 'Projecten', updated_at = now()
where key = 'projecten' and name <> 'Projecten';

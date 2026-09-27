-- Migratie: aliassen per kolom (DOEL-56).
--
-- Een alias is een extra, zelfstandig te kiezen elementtype dat in dezelfde
-- kolom wordt getoond als zijn basistype (bv. "Project 1"/"Project 2" als
-- alias van "Project"), met een optionele eigen kleur. Bewust als
-- jsonb-array op de kolom zelf (columns.aliases) i.p.v. een aparte tabel: een
-- alias hoort onlosmakelijk bij precies één kolom en wordt nooit los daarvan
-- gequeried — zelfde afweging als bij doelenboom_templates.columns_snapshot.
-- Validatie (unieke typeName over alle kolommen+aliassen van de config,
-- geldige hexkleur) gebeurt op API-niveau in api/src/columnConfig.ts, niet in
-- de database (zelfde reden als bij elements.type, zie 0001_column_configs.sql).
--
-- Idempotent (if not exists) — veilig om per ongeluk twee keer te draaien, en
-- exact gespiegeld in db/init.sql zodat een gloednieuwe installatie en een
-- bestaande, gemigreerde productiedatabase op hetzelfde schema uitkomen.
--
-- Gebruik:
--   set -euo pipefail
--   docker compose exec -T db psql -U doelenboom -d doelenboom -v ON_ERROR_STOP=1 < db/migrations/0043_column_type_aliases.sql
begin;

alter table columns add column if not exists aliases jsonb not null default '[]'::jsonb;

commit;

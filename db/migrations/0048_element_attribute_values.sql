-- Migratie: kenmerkwaarden per element (DOEL-76, epic DOEL-61 "Module
-- Controleregels"; ontwerp: doelenboom_kenmerken_ontwerp.md). Vervolg op
-- 0047 (de kenmerkDEFINITIES in column_configs.attributes).
--
-- Tabel element_attribute_values: één rij per (element, kenmerk) met een
-- ingevulde waarde. Een leeg kenmerk heeft geen rij.
-- - attribute_id verwijst naar een definitie in column_configs.attributes
--   (jsonb) van dezelfde doelenboom. Geen foreign key mogelijk; de API
--   (api/src/elementAttributeValues.ts) controleert bij het schrijven dat het
--   kenmerk bestaat en voor het type van het element geldt, en ruimt waarden
--   op zodra een kenmerk of keuzelijstwaarde uit de definities verdwijnt.
-- - Eén waardekolom per soort: value_text (tekst en keuzelijst, max. 200
--   tekens), value_number, value_date, value_bool. Precies één ervan is
--   gevuld (check); de lengtegrens staat ook hier, niet alleen in de API.
-- - element_id en doelenboom_id met cascade: een element of boom verwijderen
--   neemt de waarden mee. Een Excel-import (die alle elementen vervangt)
--   legt de waarden vooraf vast en zet ze terug, zie routes/imports.ts.
-- - updated_by/updated_at zet alleen de server.
-- - Alleen metagegevens: geen inhoudelijke of gerubriceerde informatie. De
--   waarden komen nooit in audit_log.
--
-- Bestaande bomen hebben geen waarden en gedragen zich ongewijzigd.
-- Idempotent (if not exists) en exact gespiegeld in db/init.sql. Draai dit
-- VÓÓR het uitrollen van de nieuwe API-versie.
--
-- Gebruik:
--   set -euo pipefail
--   docker compose exec -T db psql -U doelenboom -d doelenboom -v ON_ERROR_STOP=1 < db/migrations/0048_element_attribute_values.sql
begin;

create table if not exists element_attribute_values (
  id bigserial primary key,
  doelenboom_id bigint not null references doelenbomen(id) on delete cascade,
  element_id bigint not null references elements(id) on delete cascade,
  attribute_id text not null check (attribute_id ~ '^[A-Za-z0-9_-]{1,30}$'),
  value_text text check (value_text is null or char_length(value_text) between 1 and 200),
  value_number numeric check (value_number is null or abs(value_number) <= 999999999999999),
  value_date date,
  value_bool boolean,
  updated_by bigint references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (element_id, attribute_id),
  check (num_nonnulls(value_text, value_number, value_date, value_bool) = 1)
);
create index if not exists idx_eav_doelenboom on element_attribute_values(doelenboom_id);

commit;

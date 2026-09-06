-- Klantnummer (los van tenants.id) — Charles' verzoek (6 september 2026):
-- "naast klant id, wat een unieke code is en blijft, wil ik klantnummers in
-- productie eenmalig kunnen wijzigen." tenants.id blijft de onveranderlijke
-- technische identifier (primary key, overal in foreign keys gebruikt — nooit
-- wijzigbaar); customer_number is een apart, door een sysadmin vrij
-- herschikbaar zakelijk volgnummer (bv. "Liefting wordt nummer 1, Arko
-- Consulting nummer 2"), puur voor weergave/administratie. Net als de andere
-- klantbeheervelden (zie migratie 0033) hoort dit in tenant_customer_info,
-- niet op tenants zelf.
--
-- Nullable (niet elke tenant hoeft meteen een klantnummer te hebben) maar wel
-- uniek zodra gezet — een plain unique index in Postgres staat willekeurig
-- veel NULLs toe (elke NULL telt als verschillend van elke andere NULL), dus
-- geen aparte "where customer_number is not null"-constructie nodig zoals bij
-- tenant_contacts.is_primary (dat is een boolean, waar juist wél maar één
-- specifieke waarde—true—uniek moet zijn).
begin;

alter table tenant_customer_info add column if not exists customer_number integer;
create unique index if not exists idx_tenant_customer_info_customer_number
  on tenant_customer_info(customer_number);

commit;

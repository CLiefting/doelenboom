-- Modules ("opties") op een abonnement krijgen een eigen start- en
-- einddatum, en kunnen los van het abonnement zelf worden opgezegd —
-- Charles' verzoek (6 september 2026): "opties op abonnementen hebben ook
-- een start en einddatum. kunnen ook afzonderlijk worden opgezegd." Zelfde
-- polis-model als tenants.subscription_cancelled_at (zie db/migrations/
-- 0035_subscription_cancellation.sql): end_date is de contractuele
-- einddatum, cancelled_at de opzegging — pas als BEIDE het geval zijn (dus
-- opgezegd én de einddatum gepasseerd) wordt de module inactief. Zonder
-- opzegging loopt een module gewoon door, ook na de (kalendermatige)
-- einddatum, exact zoals bij het abonnement zelf.
--
-- start_date maakt daarnaast een NOG NIET gestarte toewijzing mogelijk (een
-- module die pas over een maand ingaat, bv. bij een vooraf afgesproken
-- uitbreiding) — voor bestaande rijen is er geen eerder vastgelegde
-- "ingangsdatum", dus die backfillen we vanaf het bestaande activated_at
-- (de dichtstbijzijnde benadering, en historisch al de aanmaakdatum van de
-- toewijzing).
begin;

alter table tenant_modules add column if not exists start_date date;
update tenant_modules set start_date = activated_at::date where start_date is null;
alter table tenant_modules alter column start_date set not null;
alter table tenant_modules alter column start_date set default current_date;

alter table tenant_modules add column if not exists end_date date;
alter table tenant_modules add column if not exists cancelled_at timestamptz;

commit;

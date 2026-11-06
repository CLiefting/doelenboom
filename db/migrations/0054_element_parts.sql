-- Migratie: samengestelde elementen (DOEL-140).
--
-- Een samengesteld element (het "geheel") bestaat uit een of meer
-- deelelementen in dezelfde kolom. Geheel en delen blijven volwaardige
-- elementen (eigen code, kenmerken, relaties); deze tabel legt alleen de
-- geheel-deelkoppeling vast. Bewust een aparte koppeltabel i.p.v. een kolom
-- op elements: het transferscript (DOEL-104/DOEL-133, api/src/
-- doelenboomTransfer.ts) kopieert elements in één keer op sort_order, en een
-- verwijzing van elements naar elements is dan niet te vertalen (een deel
-- kan vóór zijn geheel staan). Deze tabel staat ná elements in de
-- kopieervolgorde.
--
-- Regels:
-- - part_element_id is uniek: een element is deel van hooguit één geheel;
-- - geheel en deel horen bij doelenboom_id (trigger);
-- - geen element is zijn eigen geheel (check);
-- - één niveau: een geheel is zelf geen deel, en een deel heeft zelf geen
--   delen (trigger);
-- - "zelfde kolom" controleert de API (de kolom volgt uit elements.type en
--   de kolomconfiguratie van de boom, net als de typecontrole nu al).
-- on delete cascade op beide elementen: verwijdert iemand een geheel of een
-- deel, dan vervalt de koppeling; het deel blijft dan als gewoon element
-- bestaan (tenzij de API het op verzoek mee verwijdert).
--
-- Daarnaast drie nieuwe auditgebeurtenissen (detail: alleen codes, nooit
-- namen of andere vrije tekst):
--   'element_parts_composed'   — samengevoegd   { whole, parts }
--   'element_parts_detached'   — losgemaakt     { whole, parts }
--   'element_whole_deleted'    — geheel verwijderd { whole, parts, partsAction }
--
-- Niet los draaien: gebruik scripts/db-migrate.sh (zie deploy/README.md,
-- "Databasemigraties"). Idempotent.
begin;

create table if not exists element_parts (
  id bigserial primary key,
  doelenboom_id bigint not null references doelenbomen(id) on delete cascade,
  whole_element_id bigint not null references elements(id) on delete cascade,
  part_element_id bigint not null references elements(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (part_element_id),
  check (whole_element_id <> part_element_id)
);
create index if not exists idx_element_parts_whole on element_parts(whole_element_id);
create index if not exists idx_element_parts_doelenboom on element_parts(doelenboom_id);

create or replace function element_parts_guard() returns trigger language plpgsql as $$
begin
  if (select doelenboom_id from elements where id = new.whole_element_id) is distinct from new.doelenboom_id
     or (select doelenboom_id from elements where id = new.part_element_id) is distinct from new.doelenboom_id then
    raise exception 'element_parts: geheel en deel horen niet bij dezelfde doelenboom'
      using errcode = '23514';
  end if;
  if exists (select 1 from element_parts where part_element_id = new.whole_element_id and id is distinct from new.id) then
    raise exception 'element_parts: het geheel is zelf een deelelement (maximaal één niveau)'
      using errcode = '23514';
  end if;
  if exists (select 1 from element_parts where whole_element_id = new.part_element_id and id is distinct from new.id) then
    raise exception 'element_parts: het deelelement heeft zelf delen (maximaal één niveau)'
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists element_parts_guard on element_parts;
create trigger element_parts_guard before insert or update on element_parts
  for each row execute function element_parts_guard();

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'audit_log_event_type_check') then
    alter table audit_log drop constraint audit_log_event_type_check;
  end if;
  alter table audit_log add constraint audit_log_event_type_check
    check (event_type in (
      'doelenboom_view', 'tenant_settings_changed', 'mfa_verified', 'mfa_failed',
      'tenant_contact_changed', 'tenant_customer_info_changed', 'tenant_subscription_changed',
      'doelenboom_wiped',
      'login_success', 'login_failed', 'account_locked', 'password_changed', 'password_reset',
      'user_created', 'user_updated', 'user_deleted', 'tenant_member_changed',
      'doelenboom_deleted', 'doelenboom_exported', 'doelenboom_import_published',
      'control_rules_updated',
      'control_rule_deviation_set', 'control_rule_deviation_removed',
      'dependency_vulnerability_alert_sent',
      'attribute_definitions_updated',
      'elements_bulk_deleted',
      'app_settings_updated',
      'dependency_vulnerability_overview_sent',
      'element_parts_composed', 'element_parts_detached', 'element_whole_deleted'
    ));
end $$;

commit;

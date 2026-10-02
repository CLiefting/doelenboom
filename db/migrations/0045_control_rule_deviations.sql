-- Migratie: gemotiveerde afwijkingen van controleregels (DOEL-64, epic
-- DOEL-61 "Module Controleregels").
--
-- 1. control_rule_deviations — per (element, regel-id) een korte motivatie
--    waarom bewust van een controleregel wordt afgeweken. In de boom wordt
--    zo'n overtreding dan "gemotiveerd afgeweken" (grijs) i.p.v. open
--    (oranje). rule_id verwijst naar een regel in column_configs.rules
--    (jsonb, dus geen foreign key): de API controleert dat de regel bestaat
--    en ruimt de afwijkingen op zodra een regel uit de configuratie van de
--    boom verdwijnt (besluit Charles 2 oktober 2026: direct opruimen, geen
--    aparte opschoonknop). motivatie: 1-500 tekens, ook op API-niveau
--    afgedwongen; alleen een motivatie op hoofdlijnen, geen inhoudelijke of
--    gerubriceerde informatie. created_/updated_-velden zet alleen de server
--    (patroon project_status). Cascade op element en doelenboom: element
--    verwijderen, wipe_on_empty en tenant-wipe ruimen de rijen vanzelf op.
--    Afwijkingen gaan niet mee in sjablonen of bij dupliceren.
-- 2. audit_log: nieuwe event_types 'control_rule_deviation_set' en
--    'control_rule_deviation_removed' (detail = elementcode + regel-id —
--    NOOIT de motivatietekst). Zelfde constraint-vervangpatroon als 0042/0044.
--
-- Idempotent (if not exists / constraint vervangen). Draai dit VÓÓR het
-- uitrollen van de nieuwe API-versie.
--
-- Gebruik:
--   set -euo pipefail
--   docker compose exec -T db psql -U doelenboom -d doelenboom -v ON_ERROR_STOP=1 < db/migrations/0045_control_rule_deviations.sql
begin;

create table if not exists control_rule_deviations (
  id bigserial primary key,
  doelenboom_id bigint not null references doelenbomen(id) on delete cascade,
  element_id bigint not null references elements(id) on delete cascade,
  rule_id text not null check (rule_id ~ '^[A-Za-z0-9_-]{1,40}$'),
  motivatie text not null check (char_length(motivatie) between 1 and 500),
  created_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by bigint references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (element_id, rule_id)
);
create index if not exists idx_crd_doelenboom on control_rule_deviations(doelenboom_id);

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
      'control_rule_deviation_set', 'control_rule_deviation_removed'
    ));
end $$;

commit;

-- Migratie: controleregels per kolomconfiguratie (DOEL-62, epic DOEL-61
-- "Module Controleregels").
--
-- 1. column_configs.rules — jsonb-array van controleregels (structuurregels
--    zoals "elk element van type X heeft minstens 1 ouder van type Y"). Bewust
--    op de kolomconfiguratie (niet op columns): een regel verwijst naar typen
--    uit meerdere kolommen en hoort bij de configuratie van één doelenboom
--    (of bij de tenant-default, waarvandaan hij bij een nieuwe boom wordt
--    meegekopieerd). Zelfde jsonb-afweging als columns.aliases (0043): wordt
--    nooit los gequeried, alleen als geheel gelezen. Het regelschema
--    (id/kind/subjectTypes/targetTypes/weight/min/max/tagCategory/field/
--    label/explanation/enabled) en alle validatie (whitelist van velden en
--    regeltypen, max. 50 regels, typen moeten bestaan in de kolommen+aliassen
--    van dezelfde config) zitten op API-niveau in api/src/controlRules.ts,
--    niet in de database — zelfde reden als bij elements.type
--    (0001_column_configs.sql). Alleen STRUCTUURregels; statusregels (werking
--    van maatregelen, gaps) bestaan bewust niet (epic DOEL-61, uitgangspunt 2).
-- 2. doelenboom_templates.rules_snapshot — regels gaan mee in sjablonen
--    (opslaan/toepassen). Eigen kolom i.p.v. binnen columns_snapshot (dat is
--    een array van kolommen). Bestaande sjablonen krijgen '[]'.
-- 3. audit_log: nieuw event_type 'control_rules_updated' (detail bevat alleen
--    scope, aantal en regel-id's — nooit labels/uitleg). Zelfde
--    constraint-vervangpatroon als 0042.
-- 4. modules: licentiemodule 'controleregels' (besluit Charles 1 oktober
--    2026, zie DOEL-62). Bewust nog GEEN rij in module_surcharges/
--    module_tier_surcharges: telt voorlopig niet mee in de aanvraagprijs,
--    net als KPI/Backup (doelenboom_licentiemodel.md §3/§8).
--
-- Bestaande kolomconfiguraties krijgen rules = '[]' en gedragen zich
-- ongewijzigd. Idempotent (if not exists / on conflict do nothing /
-- constraint opnieuw opbouwen) en exact gespiegeld in db/init.sql. Draai dit
-- VÓÓR het uitrollen van de nieuwe API-versie.
--
-- Gebruik:
--   set -euo pipefail
--   docker compose exec -T db psql -U doelenboom -d doelenboom -v ON_ERROR_STOP=1 < db/migrations/0044_column_config_rules.sql
begin;

alter table column_configs add column if not exists rules jsonb not null default '[]'::jsonb;
alter table doelenboom_templates add column if not exists rules_snapshot jsonb not null default '[]'::jsonb;

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
      'control_rules_updated'
    ));
end $$;

insert into modules (key, name, description) values
  (
    'controleregels',
    'Controleregels',
    'Structuurcontrole op de doelenboom: per doelenboom in te stellen regels (bv. "elk element van type X heeft ' ||
    'minstens één ouder van type Y"), met signalering van ontbrekende schakels. Alleen structuur, geen ' ||
    'inhoudelijke of statusinformatie.'
  )
on conflict (key) do nothing;

commit;

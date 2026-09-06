-- Tweestapsverificatie (MFA, CISO-aandachtspunt) — zie doelenboom_mfa_
-- ontwerp.md in het project en api/src/mfa.ts. Verplicht voor sysadmin-
-- accounts, optioneel (zelf aan/uit te zetten) voor de rest.
begin;

alter table users add column if not exists mfa_enabled boolean not null default false;

-- Idempotentie-fix (6 september 2026, na een echte crash bij Charles: een
-- her-run van alle migraties liep hier stuk met "check constraint
-- audit_log_event_type_check is violated by some row"): de oorspronkelijke
-- versie hieronder herstelde bij elke her-run blind de SMALLE lijst van 4
-- event_types, ook als een LATERE migratie (0033_customer_management.sql)
-- 'm inmiddels al had verbreed naar 7 — zodra er dan echte audit_log-rijen
-- met zo'n nieuwer event_type (bv. tenant_contact_changed) bestaan, loopt die
-- reset stuk op precies die rijen. 0033 is zelf al volledig idempotent en de
-- bron van waarheid voor de actuele, volledige lijst — deze migratie moet dus
-- NOOIT terugzetten naar de smalle lijst zodra 'ie al verbreed is, door
-- zichzelf bij een eerdere run of door 0033.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'audit_log_event_type_check'
  ) then
    -- Verse installatie: db/init.sql heeft de kolom al met de volledige
    -- check-constraint aangemaakt, niets te doen hier.
    null;
  elsif position('mfa_verified' in pg_get_constraintdef(
    (select oid from pg_constraint where conname = 'audit_log_event_type_check')
  )) = 0 then
    -- Eerste keer dat deze migratie draait op een bestaande database van vóór
    -- MFA: de constraint staat nog op de oorspronkelijke (0028) lijst van 2
    -- event_types — verbreden naar de 4 die op dát moment bekend waren.
    alter table audit_log drop constraint audit_log_event_type_check;
    alter table audit_log add constraint audit_log_event_type_check
      check (event_type in ('doelenboom_view', 'tenant_settings_changed', 'mfa_verified', 'mfa_failed'));
  else
    -- Al verbreed (door deze migratie zelf eerder, of door 0033 daarna) --
    -- niets te doen, zie toelichting hierboven.
    null;
  end if;
end $$;

create table if not exists mfa_challenges (
  id text primary key,
  user_id bigint not null references users(id) on delete cascade,
  code_hash text not null,
  attempts integer not null default 0,
  resend_count integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_mfa_challenges_user on mfa_challenges(user_id, created_at desc);

commit;

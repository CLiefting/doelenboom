-- Tweestapsverificatie (MFA, CISO-aandachtspunt) — zie doelenboom_mfa_
-- ontwerp.md in het project en api/src/mfa.ts. Verplicht voor sysadmin-
-- accounts, optioneel (zelf aan/uit te zetten) voor de rest.
begin;

alter table users add column if not exists mfa_enabled boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'audit_log_event_type_check'
  ) then
    -- Verse installatie: db/init.sql heeft de kolom al met de volledige
    -- check-constraint aangemaakt, niets te doen hier.
    null;
  else
    alter table audit_log drop constraint audit_log_event_type_check;
    alter table audit_log add constraint audit_log_event_type_check
      check (event_type in ('doelenboom_view', 'tenant_settings_changed', 'mfa_verified', 'mfa_failed'));
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

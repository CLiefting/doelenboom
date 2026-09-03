-- Rate limiting / tijdelijke accountblokkade bij herhaalde mislukte
-- inlogpogingen (CISO-aandachtspunt) — zie auth.ts POST /login en
-- api/src/appSettings.ts.
--
-- Twee nieuwe kolommen op users (bijhouden van mislukte pogingen/blokkade)
-- plus een nieuwe app_settings-tabel (sysadmin-instelbare drempel/duur,
-- app-breed, precies één rij).
--
-- Draai dit één keer tegen een BESTAANDE database (lokale dev-db én
-- productie); voor VERSE installaties staat dit al goed in db/init.sql.
--
-- Gebruik (lokaal):
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0026_login_lockout.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
--
-- Idempotent ("add column if not exists" / "create table if not exists" /
-- "on conflict do nothing"): veilig meerdere keren te draaien.

begin;

alter table users add column if not exists failed_login_count integer not null default 0;
alter table users add column if not exists locked_until timestamptz;

create table if not exists app_settings (
  id integer primary key default 1 check (id = 1),
  max_failed_login_attempts integer not null default 5 check (max_failed_login_attempts > 0),
  login_lockout_minutes integer not null default 15 check (login_lockout_minutes > 0)
);
insert into app_settings (id) values (1) on conflict (id) do nothing;

commit;

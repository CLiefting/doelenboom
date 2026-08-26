-- Migratie: rol 'bezoeker' toevoegen (zie api/src/rbac.ts voor het volledige
-- rolmodel). Draai dit één keer tegen een BESTAANDE database (lokale dev-db
-- én productie) die de check-constraints nog met alleen ('admin', 'gebruiker')
-- heeft; voor VERSE installaties staat 'bezoeker' er al bij in db/init.sql
-- (dat draait automatisch bij de allereerste containerstart).
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0004_bezoeker_role.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
--
-- Idempotent: mag zonder gevolgen twee keer gedraaid worden (drop/re-add
-- constraint, geen data-wijziging — bestaande 'admin'/'gebruiker'-rijen
-- blijven ongemoeid, niemand wordt automatisch 'bezoeker').

begin;

alter table tenant_users drop constraint if exists tenant_users_role_check;
alter table tenant_users add constraint tenant_users_role_check
  check (role in ('admin', 'gebruiker', 'bezoeker'));

alter table doelenboom_user_roles drop constraint if exists doelenboom_user_roles_role_check;
alter table doelenboom_user_roles add constraint doelenboom_user_roles_role_check
  check (role in ('admin', 'gebruiker', 'bezoeker'));

commit;

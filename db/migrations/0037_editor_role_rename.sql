-- Migratie: tenant-rol 'gebruiker' hernoemen naar 'editor' — zie
-- doelenboom_licentiemodel.md §5 v3 en de prijsstrategie-notitie van Charles
-- (7 september 2026): "gebruiker komt straks te vervallen. wordt Editor.
-- Admin telt mee als editor." Puur een naamswijziging van de bestaande rol
-- (zelfde rechten als voorheen: lezen + "losse boom-inhoud" wijzigen, zie
-- api/src/rbac.ts) — geen nieuwe rol, geen gedragswijziging op zichzelf. De
-- licentielimiet-wijziging (admin + editor tellen samen tegen
-- tiers.max_editors) zit in db/migrations/0038_prijsstrategie_v3.sql.
--
-- Volgorde is belangrijk: eerst de CHECK-constraints verwijderen (die staan
-- de UPDATE naar 'editor' anders niet toe), dan de data bijwerken, dan de
-- constraints met de nieuwe toegestane waarde terugzetten. Idempotent: elke
-- stap kan veilig herhaald worden (IF EXISTS / de UPDATE raakt na de eerste
-- keer gewoon 0 rijen).
--
-- Draai dit één keer tegen een BESTAANDE database, vóór
-- 0038_prijsstrategie_v3.sql; voor VERSE installaties staat dit al in
-- db/init.sql.
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0037_editor_role_rename.sql

alter table tenant_users drop constraint if exists tenant_users_role_check;
alter table doelenboom_user_roles drop constraint if exists doelenboom_user_roles_role_check;
alter table tenants drop constraint if exists tenants_open_access_role_check;

update tenant_users set role = 'editor' where role = 'gebruiker';
update doelenboom_user_roles set role = 'editor' where role = 'gebruiker';
update tenants set open_access_role = 'editor' where open_access_role = 'gebruiker';

alter table tenant_users add constraint tenant_users_role_check check (role in ('admin', 'editor', 'bezoeker'));
alter table doelenboom_user_roles add constraint doelenboom_user_roles_role_check check (role in ('admin', 'editor', 'bezoeker'));
alter table tenants add constraint tenants_open_access_role_check check (open_access_role in ('admin', 'editor', 'bezoeker'));

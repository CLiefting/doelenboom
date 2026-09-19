-- Migratie: e-mailverificatie voor de publieke zelfbedieningsaanvraag
-- (DOEL-20, analyse H1). Tot nu toe maakte POST /api/subscription-requests
-- direct een tenant + admin-account aan voor ELK e-mailadres, zonder dat de
-- aanvrager kon bewijzen dat het adres van hem/haar was. Nu belandt een
-- aanvraag eerst in deze tabel ("nog te bevestigen"); pas na het klikken op
-- de link in de verificatiemail (POST /api/subscription-requests/confirm)
-- ontstaan tenant + account + aanvraagrij.
--
-- token_hash: sha256 van het token uit de mail — het token zelf wordt nooit
-- opgeslagen. payload: de gevalideerde aanvraag, inclusief het al gehashte
-- wachtwoord (bcrypt via crypt()) — nooit het wachtwoord in leesbare vorm.
-- consumed_at: eenmalig te gebruiken. Verlopen/verbruikte rijen worden door
-- een uursweep in index.ts opgeruimd.
--
-- Idempotent (if not exists). Draai dit één keer tegen een BESTAANDE
-- database, VÓÓR het uitrollen van de nieuwe API-versie; voor VERSE
-- installaties staat dit al in db/init.sql.
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   docker compose exec -T db psql -U doelenboom -d doelenboom -v ON_ERROR_STOP=1 < db/migrations/0040_pending_registrations.sql
create table if not exists pending_registrations (
  id bigserial primary key,
  email text not null,
  token_hash text not null unique,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index if not exists idx_pending_registrations_email_created on pending_registrations(email, created_at);

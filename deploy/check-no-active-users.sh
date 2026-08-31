#!/usr/bin/env bash
# Voorwaarde-check vóór een productie-update (zie "Updates uitrollen" in
# deploy/README.md): `docker compose ... up -d` herstart de api/web-
# containers, wat elke ingelogde gebruiker midden in hun werk onderbreekt
# (de React-app verliest zijn state; een openstaande wijziging in de boom
# kan verloren gaan). Dit script weigert de update daarom als er nu iemand
# actief is, en meldt precies wie.
#
# "Actief" is bewust exact dezelfde definitie als GET /api/sessions (het
# Login-overzicht in de app zelf, zie api/src/routes/sessions.ts): een
# sessie telt als actief zolang 'm niet expliciet beëindigd is (ended_at is
# null) én de laatste heartbeat (de frontend stuurt er elke minuut één
# zolang een tab open staat) niet langer dan 5 minuten geleden was.
#
# Gebruik (op de VPS, ná `docker load` maar VÓÓR `docker compose ... up -d`):
#   ./deploy/check-no-active-users.sh
# Exit 0 + "Geen actieve gebruikers" => veilig om te updaten.
# Exit 1 + lijst van wie er actief is => NIET updaten; wacht tot iedereen
#   is uitgelogd (of stem eerst met ze af) en probeer het daarna opnieuw.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# .env staat alleen op de VPS (niet in git) en bevat POSTGRES_USER/POSTGRES_DB
# — zelfde aanpak als deploy/reset-demo.sh.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

POSTGRES_USER="${POSTGRES_USER:-doelenboom}"
POSTGRES_DB="${POSTGRES_DB:-doelenboom}"

ACTIVE="$(docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T db \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -t -A <<'SQL'
select u.email || '|' || to_char(s.last_seen_at, 'DD-MM-YYYY HH24:MI')
from sessions s
join users u on u.id = s.user_id
where s.ended_at is null
  and s.last_seen_at > now() - interval '5 minutes'
order by s.last_seen_at desc;
SQL
)"

if [ -z "$ACTIVE" ]; then
  echo "Geen actieve gebruikers ingelogd — veilig om te updaten."
  exit 0
fi

echo "LET OP: er is nu nog minstens één gebruiker actief ingelogd — NIET updaten."
echo "Een update herstart de containers en onderbreekt hun sessie."
echo
echo "Actief (laatst gezien binnen 5 minuten):"
while IFS='|' read -r email last_seen; do
  [ -z "$email" ] && continue
  echo "  - $email (laatst gezien: $last_seen)"
done <<<"$ACTIVE"
echo
echo "Wacht tot iedereen is uitgelogd (of stem eerst met ze af), en draai dit script dan opnieuw."
exit 1

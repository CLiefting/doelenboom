#!/usr/bin/env bash
# Genereert een CycloneDX Software Bill of Materials voor alle drie de
# Doelenboom-onderdelen (api/web/excel-service) in ./sbom/ — zie
# doelenboom_sbom_ontwerp.md in het project en api/src/dependencyHealth.ts
# (dat deze map runtime inleest, zie SBOM_DIR verderop/deploy/README.md).
#
# LET OP — dit script is NIET meer onderdeel van de release-flow: de SBOM wordt
# sinds 19 september 2026 tijdens `docker compose build` in de images zelf
# gegenereerd (SBOM-stages in api/Dockerfile, api/Dockerfile.prod en
# excel-service/Dockerfile) en staat daarna in de api-image (/app/sbom, zie
# SBOM_DIR). Dit script is alleen nog handig om de Softwarecomponenten-pagina
# uit te proberen met de API BUITEN Docker (`npm run dev` vanuit api/, waar
# dependencyHealth.ts terugvalt op ../sbom). Het script cd't zelf naar
# ~/OneDrive/src/doelenboom (zie hieronder), dus vanaf welke map je het
# aanroept maakt niet uit.
#
# Vereisten: node/npx (voor cyclonedx-npm, via npx — geen extra
# package.json-dependency nodig, zie §28 "minimaliseer nieuwe dependencies"),
# en voor excel-service een al opgezette venv MET requirements-dev.txt erin
# (die bevat nu ook cyclonedx-bom, zie pre-build.sh/TESTING.md — dezelfde venv
# die pre-build.sh voor de pytest-run gebruikt).
#
# Geen SBOM's? Dan valt de Softwarecomponenten-pagina netjes terug op "geen
# SBOM beschikbaar" (zie dependencyHealth.ts) i.p.v. te crashen — dit script
# hoeft dus niet bij élke lokale `npm run dev` te draaien, alleen vóór een
# echte build/deploy of als je de pagina lokaal wil uitproberen.
set -euo pipefail

# Vaste, veilige locatie i.p.v. dynamische BASH_SOURCE-resolutie — zie
# doelenboom-cli.sh voor de achtergrond (Charles, 14 september 2026).
# DOEL-33: overschrijfbaar (DOELENBOOM_DIR) zodat de map buiten OneDrive kan staan.
REPO_DIR="${DOELENBOOM_DIR:-$HOME/OneDrive/src/doelenboom}"
if [ ! -f "$REPO_DIR/docker-compose.yml" ]; then
  echo "Kan doelenboom niet vinden op $REPO_DIR (geen docker-compose.yml daar)." >&2
  echo "Is de map leeg, verplaatst, of nog niet gesynchroniseerd (bv. door een OneDrive-issue)? Controleer dit eerst." >&2
  exit 1
fi
cd "$REPO_DIR"

CYCLONEDX_NPM_VERSION="6.0.1"
OUT="sbom"
mkdir -p "$OUT"

echo "==> api: CycloneDX-SBOM genereren (npm, package-lock.json)"
(cd api && npx --yes "@cyclonedx/cyclonedx-npm@${CYCLONEDX_NPM_VERSION}" \
  --package-lock-only --output-format JSON --output-file "../${OUT}/api.cdx.json")

echo "==> web: CycloneDX-SBOM genereren (npm, package-lock.json)"
(cd web && npx --yes "@cyclonedx/cyclonedx-npm@${CYCLONEDX_NPM_VERSION}" \
  --package-lock-only --output-format JSON --output-file "../${OUT}/web.cdx.json")

echo "==> excel-service: CycloneDX-SBOM genereren (Python-venv)"
if [ ! -x excel-service/.venv/bin/cyclonedx-py ]; then
  echo "excel-service/.venv mist cyclonedx-py (cyclonedx-bom) — draai eerst" >&2
  echo "'./scripts/pre-build.sh' (die zet de venv incl. requirements-dev.txt op)," >&2
  echo "of handmatig: excel-service/.venv/bin/pip install -r excel-service/requirements-dev.txt" >&2
  exit 1
fi
excel-service/.venv/bin/cyclonedx-py environment excel-service/.venv \
  --of JSON -o "${OUT}/excel-service.cdx.json"
excel-service/.venv/bin/python3 scripts/sbom_python_scope.py \
  excel-service/requirements.txt excel-service/.venv > "${OUT}/excel-service.runtime-names.json"

echo "==> Nabewerken (direct/transitive + runtime/development-classificatie, gecombineerde SBOM)"
node scripts/sbom-postprocess.mjs

echo
echo "SBOM's staan in ./${OUT}/ (build-artefacten, niet in git — zie .gitignore)."

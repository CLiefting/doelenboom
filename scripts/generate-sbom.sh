#!/usr/bin/env bash
# Genereert een CycloneDX Software Bill of Materials voor alle drie de
# Doelenboom-onderdelen (api/web/excel-service) in ./sbom/ — zie
# doelenboom_sbom_ontwerp.md in het project en api/src/dependencyHealth.ts
# (dat deze map runtime inleest, zie SBOM_DIR verderop/deploy/README.md).
#
# Hoort bij elke build te draaien, vóór `docker compose build`/`up --build`,
# zelfde plek in de flow als scripts/build-version.sh:
#
#   set -euo pipefail
#   cd ~/OneDrive/src/doelenboom
#   ./scripts/pre-build.sh          # draait dit script ook zelf, zie onderaan
#   export BUILD_VERSION="$(./scripts/build-version.sh)"
#   docker compose up --build
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
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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

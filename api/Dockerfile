# ---------------------------------------------------------------------------
# SBOM-stage: genereert tijdens de image-build de Software Bill of Materials
# (CycloneDX) voor alle drie de Doelenboom-onderdelen en voegt ze samen tot de
# map die dependencyHealth.ts runtime inleest (SBOM_DIR=/app/sbom). Zo hoort de
# SBOM altijd bij precies de gebouwde/gedeployde versie, zonder handmatige stap
# (zie doelenboom_sbom_ontwerp.md in het project). Named build-contexts komen
# uit docker-compose.yml (additional_contexts):
#   sbom_tools — ./scripts   (sbom-postprocess.mjs)
#   web_src    — ./web       (package.json + package-lock.json van de web-app)
#   excel_sbom — de excel-service-image (bevat /sbom, gegenereerd uit de echt
#                geïnstalleerde Python-omgeving — transitieve pip-versies zijn
#                niet gepind, dus alleen die image weet wat er echt in zit)
# api en web: uit het package-lock.json (--package-lock-only), niet uit
# node_modules — geen installatie nodig en identiek aan wat `npm ci` installeert.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS sbom
ARG BUILD_VERSION=dev
ARG GIT_REF=unknown
WORKDIR /in/api
COPY package.json package-lock.json ./
RUN npx --yes @cyclonedx/cyclonedx-npm@6.0.1 --package-lock-only \
      --output-format JSON --output-file /in/api/cdx.json
WORKDIR /in/web
COPY --from=web_src package.json package-lock.json ./
RUN npx --yes @cyclonedx/cyclonedx-npm@6.0.1 --package-lock-only \
      --output-format JSON --output-file /in/web/cdx.json
COPY --from=excel_sbom /sbom/excel-service.cdx.json /in/excel-service/cdx.json
COPY --from=excel_sbom /sbom/excel-service.runtime-names.json /in/excel-service/runtime-names.json
COPY --from=excel_sbom /sbom/requirements.txt /in/excel-service/requirements.txt
COPY --from=sbom_tools sbom-postprocess.mjs /tools/sbom-postprocess.mjs
RUN node /tools/sbom-postprocess.mjs --from /in --out /out \
      --build-version "$BUILD_VERSION" --git-commit "$GIT_REF"

FROM node:24-alpine
WORKDIR /app
# Build-versie (git-hash + datum, meegegeven door het deploy-script via
# `docker compose build --build-arg` / de BUILD_VERSION env var in
# docker-compose.yml) — puur informatief, zichtbaar via GET /api/version en
# daarmee in de footer van de app (web/src/App.tsx, tree.html). Standaard
# "dev" zodat een lokale `docker compose up --build` zonder die env var ook
# gewoon werkt.
ARG BUILD_VERSION=dev
ENV BUILD_VERSION=${BUILD_VERSION}
# Los van BUILD_VERSION (die doelenboom-cli.sh lokaal altijd hard op "dev"
# zet, zie dat script) — de daadwerkelijke git-commit/branch die lokaal
# gebouwd is, zodat de footer ("vdev") toch te herleiden is naar een
# concrete git-stand. Zie doelenboom-cli.sh voor hoe dit gevuld wordt.
ARG GIT_REF=unknown
ENV GIT_REF=${GIT_REF}
COPY package*.json ./
RUN npm install
COPY . .
# SBOM van deze build (zie SBOM-stage bovenaan) — als laatste laag, want de
# inhoud verandert bij elke build (tijdstip/serienummer/BUILD_VERSION).
# dependencyHealth.ts leest de SBOM uit SBOM_DIR; geen volume-mount meer.
ENV SBOM_DIR=/app/sbom
COPY --from=sbom /out/ /app/sbom/
EXPOSE 4000
# Alleen lokale ontwikkeling (bind-mounts, dev-server). Productie gebruikt Dockerfile.prod,
# dat niet als root draait (DOEL-31).
# nosemgrep: dockerfile.security.missing-user.missing-user
CMD ["npm", "run", "dev"]

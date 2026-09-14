FROM node:20-alpine
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
EXPOSE 4000
CMD ["npm", "run", "dev"]

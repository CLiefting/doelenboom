# Drie stages, zodat de SBOM (Software Bill of Materials) van precies déze
# image mee de image in gaat — zie doelenboom_sbom_ontwerp.md in het project:
#   base   — python + JRE + geïnstalleerde requirements (= de runtime-omgeving)
#   sbom   — inventariseert die omgeving met cyclonedx-py, in een APARTE venv
#            zodat het gereedschap zelf niet in de SBOM of de image belandt
#   (final) — base + SBOM + app-code
# Compose geeft de api-image (api/Dockerfile*) deze image mee als build-context
# ("excel_sbom", zie docker-compose.yml) om de SBOM's van alle drie de
# onderdelen tot één gecombineerde SBOM samen te voegen.
FROM python:3.12-slim AS base
WORKDIR /app
# JRE nodig voor mpxj (zie requirements.txt / app/mpp_converter.py): mpxj is een
# Java-bibliotheek (hier via JPype aangeroepen) om het binaire MS Project
# .mpp-formaat te lezen — daar bestaat geen bruikbare pure-Python-library voor.
# "headless" (geen GUI-libs) om de image zo klein mogelijk te houden.
RUN apt-get update && apt-get install -y --no-install-recommends default-jre-headless \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# SBOM-stage. "sbom_tools" is een named build-context (docker-compose.yml:
# additional_contexts -> ./scripts), want scripts/ valt buiten de
# build-context van deze service.
# Versie van cyclonedx-bom staat vast (zelfde als requirements-dev.txt, dat
# alleen nog voor generate-sbom.sh lokaal gebruikt wordt). sbom_python_scope.py
# draait bewust met de python van de omgeving die geïnventariseerd wordt.
FROM base AS sbom
COPY --from=sbom_tools sbom_python_scope.py /tools/sbom_python_scope.py
RUN python -m venv /opt/cyclonedx \
    && /opt/cyclonedx/bin/pip install --no-cache-dir cyclonedx-bom==7.3.1 \
    && mkdir -p /out \
    && /opt/cyclonedx/bin/cyclonedx-py environment /usr/local/bin/python \
         --of JSON -o /out/excel-service.cdx.json \
    && python /tools/sbom_python_scope.py requirements.txt /usr/local \
         > /out/excel-service.runtime-names.json \
    && cp requirements.txt /out/requirements.txt

FROM base
# Vóór de app-code, zodat een code-wijziging deze laag niet ongeldig maakt.
# Buiten /app/app en niet via uvicorn bereikbaar — puur voor `docker cp` en
# voor de api-image-build (zie hierboven).
COPY --from=sbom /out/ /sbom/
COPY app ./app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

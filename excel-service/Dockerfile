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
# DOEL-74: pip is alleen nodig om de requirements te installeren. Daarna
# meteen weg, in dezelfde laag: de installer hoort niet in de runtime-omgeving
# (kleiner aanvalsoppervlak, en de in python:3.12-slim meegeleverde pip had
# bekende kwetsbaarheden die zo ook uit de SBOM verdwijnen). De SBOM-stage
# hieronder inventariseert deze omgeving, dus zonder pip — precies wat er
# draait. Later iets bijinstalleren kan alleen nog via een nieuwe image-build.
RUN pip install --no-cache-dir -r requirements.txt \
    && python -m pip uninstall -y pip

# SBOM-stage. "sbom_tools" is een named build-context (docker-compose.yml:
# additional_contexts -> ./scripts), want scripts/ valt buiten de
# build-context van deze service.
# De versie van cyclonedx-bom komt uit requirements-dev.txt (één bron: zo
# loopt deze stage niet achter als Dependabot die pin bijwerkt — DOEL-74).
# sbom_python_scope.py draait bewust met de python van de omgeving die
# geïnventariseerd wordt. De venv krijgt zijn eigen pip uit de met Python
# meegeleverde ensurepip-bundel; die venv blijft in deze stage achter.
FROM base AS sbom
COPY --from=sbom_tools sbom_python_scope.py /tools/sbom_python_scope.py
COPY requirements-dev.txt /tmp/requirements-dev.txt
RUN python -m venv /opt/cyclonedx \
    && CYCLONEDX_PIN="$(grep -E '^cyclonedx-bom==[0-9.]+$' /tmp/requirements-dev.txt)" \
    && test -n "$CYCLONEDX_PIN" \
    && /opt/cyclonedx/bin/pip install --no-cache-dir "$CYCLONEDX_PIN" \
    && mkdir -p /out \
    && /opt/cyclonedx/bin/cyclonedx-py environment /usr/local/bin/python \
         --of JSON -o /out/excel-service.cdx.json \
    && python /tools/sbom_python_scope.py requirements.txt /usr/local \
         > /out/excel-service.runtime-names.json \
    && cp requirements.txt /out/requirements.txt

FROM base
# DOEL-74: ook de ensurepip-bundel (een pip-wheel in de standaardbibliotheek,
# waarmee `python -m ensurepip`/`python -m venv` pip opnieuw zou kunnen
# neerzetten) hoort niet in de runtime-image. Pas hier, niet in base: de
# SBOM-stage heeft hem nodig voor zijn eigen venv.
RUN python -c "import ensurepip, os, shutil; shutil.rmtree(os.path.dirname(ensurepip.__file__))"
# Vóór de app-code, zodat een code-wijziging deze laag niet ongeldig maakt.
# Buiten /app/app en niet via uvicorn bereikbaar — puur voor `docker cp` en
# voor de api-image-build (zie hierboven).
COPY --from=sbom /out/ /sbom/
COPY app ./app
# DOEL-31b: COPY neemt de rechten van je werkmap over. Was een bronbestand 600,
# dan kon de niet-root gebruiker het niet lezen en crashte uvicorn bij het starten.
# Daarom expliciet leesbaar maken, los van wat er lokaal staat.
RUN chmod -R a+rX /app /sbom
# DOEL-31: niet als root draaien. Deze service verwerkt door gebruikers
# geüploade bestanden (xlsx/mpp, via de JVM/mpxj); een kwetsbaarheid in een
# parser geeft zo geen root in de container. Alles onder /app, /sbom en
# /usr/local is root-eigendom en alleen-lezen voor deze gebruiker; tijdelijke
# bestanden gaan naar /tmp. Geen bytecode schrijven (app-map is niet schrijfbaar).
ENV PYTHONDONTWRITEBYTECODE=1
RUN useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin excel
USER excel
EXPOSE 8000
# Geen curl in python:slim; de standaardbibliotheek volstaat. /health bestaat in app/main.py.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

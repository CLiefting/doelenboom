#!/usr/bin/env node
// Verwerkt de ruwe CycloneDX-output tot wat api/src/dependencyHealth.ts nodig
// heeft: per component een klein .meta.json-zusje (directe namen +
// runtime-namen, voor de direct/transitive- en runtime/development-
// classificatie), een gecombineerde SBOM over alle drie de Doelenboom-
// onderdelen heen (§4 van de opdracht: "maak bij voorkeur ook een
// gecombineerd applicatieoverzicht"), en één meta.json met de build-brede
// metadata. Puur Node stdlib (fs/path) — geen extra dependency nodig.
//
// Twee manieren om dit script te draaien (zelfde logica, andere in-/uitvoer):
//
// 1. Zonder argumenten (lokaal, na scripts/generate-sbom.sh): leest de ruwe
//    SBOM's uit ./sbom/ en de manifesten (package.json, requirements*.txt)
//    uit de repo, en schrijft het resultaat terug naar ./sbom/. Bedoeld voor
//    de API draaien buiten Docker (`npm run dev`, zie generate-sbom.sh).
//
// 2. Met --from/--out (tijdens `docker compose build`, in de SBOM-stage van
//    api/Dockerfile en api/Dockerfile.prod): leest per onderdeel een
//    invoermap en schrijft de complete SBOM-set naar --out, die daarna in de
//    api-image terechtkomt (/app/sbom, zie SBOM_DIR). Verwachte indeling:
//      <from>/api/{cdx.json, package.json}
//      <from>/web/{cdx.json, package.json}
//      <from>/excel-service/{cdx.json, runtime-names.json, requirements.txt}
//    Verder: --build-version en --git-commit (de BUILD_VERSION/GIT_REF
//    build-args van de image; --git-commit mag "branch@hash[-dirty]",
//    een kale hash of "unknown" zijn — bij "unknown" wordt de hash uit
//    --build-version gehaald, zie commitFromRef()).
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const { values: args } = parseArgs({
  options: {
    from: { type: 'string' },
    out: { type: 'string' },
    'build-version': { type: 'string' },
    'git-commit': { type: 'string' },
  },
  allowPositionals: false,
});

const IMAGE_MODE = args.from !== undefined;
if (IMAGE_MODE && !args.out) {
  console.error('--out is verplicht samen met --from');
  process.exit(2);
}
const OUT = IMAGE_MODE ? path.resolve(args.out) : path.join(ROOT, 'sbom');
mkdirSync(OUT, { recursive: true });

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function directNamesFromPackageJson(pkgPath) {
  const pkg = readJson(pkgPath);
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
}

function directNamesFromRequirements(...reqPaths) {
  const names = new Set();
  for (const p of reqPaths) {
    if (!existsSync(p)) continue;
    for (const rawLine of readFileSync(p, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('-')) continue;
      const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
      if (match) names.add(normalizePyName(match[1]));
    }
  }
  return names;
}

function normalizePyName(name) {
  return name.replace(/[-_.]+/g, '-').toLowerCase();
}

// cyclonedx-npm zet zelf al een 'cdx:npm:package:development'-property op elk
// component dat alleen als devDependency (transitief) geïnstalleerd wordt —
// afwezig (niet "false") voor een runtime-package. Dat is nauwkeuriger dan
// zelf twee SBOM's (met/zonder --omit dev) te diffen, en gebruikt npm's eigen
// installatie-boom-kennis in plaats van een eigen heuristiek.
function npmRuntimeComponentNames(cdxDoc) {
  const names = new Set();
  for (const c of cdxDoc.components ?? []) {
    const isDev = (c.properties ?? []).some(
      (p) => p.name === 'cdx:npm:package:development' && p.value === 'true'
    );
    if (!isDev) names.add(c.group ? `${c.group}/${c.name}` : c.name);
  }
  return names;
}

// Waar staan de invoerbestanden per onderdeel? Zie de header hierboven voor de
// twee indelingen (repo-indeling na generate-sbom.sh, of de --from-indeling in
// de Docker-build).
function inputSources() {
  if (IMAGE_MODE) {
    const from = path.resolve(args.from);
    return {
      api: { cdx: path.join(from, 'api', 'cdx.json'), manifest: path.join(from, 'api', 'package.json') },
      web: { cdx: path.join(from, 'web', 'cdx.json'), manifest: path.join(from, 'web', 'package.json') },
      excel: {
        cdx: path.join(from, 'excel-service', 'cdx.json'),
        runtimeNames: path.join(from, 'excel-service', 'runtime-names.json'),
        // In de image staan alleen de runtime-packages (geen requirements-dev.txt).
        requirements: [path.join(from, 'excel-service', 'requirements.txt')],
      },
    };
  }
  return {
    api: { cdx: path.join(OUT, 'api.cdx.json'), manifest: path.join(ROOT, 'api', 'package.json') },
    web: { cdx: path.join(OUT, 'web.cdx.json'), manifest: path.join(ROOT, 'web', 'package.json') },
    excel: {
      cdx: path.join(OUT, 'excel-service.cdx.json'),
      runtimeNames: path.join(OUT, 'excel-service.runtime-names.json'),
      requirements: [
        path.join(ROOT, 'excel-service', 'requirements.txt'),
        path.join(ROOT, 'excel-service', 'requirements-dev.txt'),
      ],
    },
  };
}

// In de --from-modus staat de ruwe SBOM nog niet in OUT — die hoort er straks
// wél in te staan (dependencyHealth.ts leest <onderdeel>.cdx.json uit SBOM_DIR).
function ensureCdxInOut(componentKey, cdxPath) {
  if (IMAGE_MODE) copyFileSync(cdxPath, path.join(OUT, `${componentKey}.cdx.json`));
}

function processNpmComponent(componentKey, src) {
  const full = readJson(src.cdx);
  const directNames = [...directNamesFromPackageJson(src.manifest)];
  const runtimeNames = [...npmRuntimeComponentNames(full)];
  ensureCdxInOut(componentKey, src.cdx);
  writeFileSync(
    path.join(OUT, `${componentKey}.meta.json`),
    JSON.stringify({ directNames, runtimeNames }, null, 2)
  );
  return full;
}

function processPythonComponent(componentKey, src) {
  const full = readJson(src.cdx);
  const scope = readJson(src.runtimeNames);
  const directNames = [...directNamesFromRequirements(...src.requirements)];
  ensureCdxInOut(componentKey, src.cdx);
  writeFileSync(
    path.join(OUT, `${componentKey}.meta.json`),
    JSON.stringify({ directNames, runtimeNames: scope.runtimeNames }, null, 2)
  );
  return full;
}

// Haalt een korte git-hash uit "branch@hash[-dirty]" (GIT_REF, zie
// doelenboom-cli.sh), een kale hash, of uit BUILD_VERSION-notatie
// "1.8.1 (9757ece-dirty, 16-09-2026 14:22)" (zie build-version.sh). Alles
// anders ("unknown", "dev", leeg) geeft null.
function commitFromRef(value) {
  if (!value) return null;
  const m = value.match(/(?:^|@|\()([0-9a-f]{7,40})(?:-dirty)?(?=[,)\s]|$)/);
  return m ? m[1] : null;
}

function resolveBuildVersion() {
  if (IMAGE_MODE) return args['build-version'] || 'dev';
  try {
    return execSync(path.join(ROOT, 'scripts', 'build-version.sh'), { cwd: ROOT }).toString().trim();
  } catch {
    return 'dev';
  }
}

function resolveGitCommit(buildVersion) {
  if (IMAGE_MODE) {
    // In de Docker-build is er geen .git (niet in de build-context) — dus
    // uitsluitend wat als build-arg is meegegeven.
    return commitFromRef(args['git-commit']) ?? commitFromRef(buildVersion);
  }
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  } catch {
    return null;
  }
}

const sources = inputSources();
const apiDoc = processNpmComponent('api', sources.api);
const webDoc = processNpmComponent('web', sources.web);
const excelDoc = processPythonComponent('excel-service', sources.excel);

const buildVersion = resolveBuildVersion();
const gitCommit = resolveGitCommit(buildVersion);

// Gecombineerd applicatieoverzicht: alle componenten van de drie SBOM's samen
// in één CycloneDX-document, met een eigen custom property die aangeeft uit
// welk Doelenboom-onderdeel elk component komt (application/frontend/backend-
// indeling gebeurt in dependencyHealth.ts zelf, dit is puur de bronmarkering).
const combinedComponents = [
  ...(apiDoc.components ?? []).map((c) => ({ ...c, properties: [...(c.properties ?? []), { name: 'doelenboom:applicationComponent', value: 'api' }] })),
  ...(webDoc.components ?? []).map((c) => ({ ...c, properties: [...(c.properties ?? []), { name: 'doelenboom:applicationComponent', value: 'web' }] })),
  ...(excelDoc.components ?? []).map((c) => ({ ...c, properties: [...(c.properties ?? []), { name: 'doelenboom:applicationComponent', value: 'excel-service' }] })),
];
const specVersion = apiDoc.specVersion ?? '1.6';
const generatedAt = new Date().toISOString();
const serialNumber = `urn:uuid:${randomUUID()}`;
const combined = {
  bomFormat: 'CycloneDX',
  specVersion,
  serialNumber,
  version: 1,
  metadata: {
    timestamp: generatedAt,
    component: {
      type: 'application',
      name: 'doelenboom',
      version: buildVersion,
    },
  },
  components: combinedComponents,
};
writeFileSync(path.join(OUT, 'combined.cdx.json'), JSON.stringify(combined, null, 2));

writeFileSync(
  path.join(OUT, 'meta.json'),
  JSON.stringify(
    {
      generatedAt,
      buildVersion,
      gitCommit,
      cyclonedxSpecVersion: specVersion,
      sbomSerialNumber: serialNumber,
      components: ['api', 'web', 'excel-service'],
    },
    null,
    2
  )
);

console.log('SBOM-nabewerking klaar:', OUT);

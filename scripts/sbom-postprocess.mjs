#!/usr/bin/env node
// Verwerkt de ruwe CycloneDX-output van scripts/generate-sbom.sh tot wat
// api/src/dependencyHealth.ts nodig heeft: per component een klein
// .meta.json-zusje (directe namen + runtime-namen, voor de direct/transitive-
// en runtime/development-classificatie), een gecombineerde SBOM over alle drie
// de Doelenboom-onderdelen heen (§4 van de opdracht: "maak bij voorkeur ook
// een gecombineerd applicatieoverzicht"), en één sbom/meta.json met de
// build-brede metadata. Puur Node stdlib (fs/path) — geen extra dependency
// nodig voor dit verwerkingsstapje.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'sbom');

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

function processNpmComponent(componentKey, dir) {
  const full = readJson(path.join(OUT, `${componentKey}.cdx.json`));
  const directNames = [...directNamesFromPackageJson(path.join(dir, 'package.json'))];
  const runtimeNames = [...npmRuntimeComponentNames(full)];
  writeFileSync(
    path.join(OUT, `${componentKey}.meta.json`),
    JSON.stringify({ directNames, runtimeNames }, null, 2)
  );
  return full;
}

function processPythonComponent(componentKey) {
  const full = readJson(path.join(OUT, `${componentKey}.cdx.json`));
  const scope = readJson(path.join(OUT, `${componentKey}.runtime-names.json`));
  const directNames = [
    ...directNamesFromRequirements(
      path.join(ROOT, 'excel-service', 'requirements.txt'),
      path.join(ROOT, 'excel-service', 'requirements-dev.txt')
    ),
  ];
  writeFileSync(
    path.join(OUT, `${componentKey}.meta.json`),
    JSON.stringify({ directNames, runtimeNames: scope.runtimeNames }, null, 2)
  );
  return full;
}

function buildVersion() {
  try {
    return execSync(path.join(ROOT, 'scripts', 'build-version.sh'), { cwd: ROOT }).toString().trim();
  } catch {
    return 'dev';
  }
}

function gitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  } catch {
    return null;
  }
}

const apiDoc = processNpmComponent('api', path.join(ROOT, 'api'));
const webDoc = processNpmComponent('web', path.join(ROOT, 'web'));
const excelDoc = processPythonComponent('excel-service');

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
      version: buildVersion(),
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
      buildVersion: buildVersion(),
      gitCommit: gitCommit(),
      cyclonedxSpecVersion: specVersion,
      sbomSerialNumber: serialNumber,
      components: ['api', 'web', 'excel-service'],
    },
    null,
    2
  )
);

console.log('SBOM-nabewerking klaar:', OUT);

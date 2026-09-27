// Regressietest voor DOEL-56: aliassen van elementtypen in web/public/tree.html.
//
// Een alias (bv. "Project 1", vastgelegd op column_configs.columns[].aliases,
// zie api/src/columnConfig.ts) hoort in dezelfde kolom te renderen als zijn
// basistype, met zijn eigen kleur als die gezet is, anders de kolomkleur.
//
// Net als tree-html-security.test.mjs/tree-html-xss.test.mjs toetst dit
// bestand het ECHTE, uitgeleverde bronbestand: buildColumnsHtml/nodeInnerHtml
// (en hun afhankelijkheid escapeHtml) worden uit de brontekst gehaald en in
// een kale sandbox uitgevoerd, zodat dit precies dezelfde code test als in de
// browser draait.
//
// Uitvoeren: node --test web/test/tree-html-alias.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(__dirname, '..', 'public', 'tree.html'), 'utf8');

function extract(re, what) {
  const m = source.match(re);
  assert.ok(m, `${what} niet gevonden in tree.html — is het hernoemd/verplaatst?`);
  return m;
}

const grab = (name) => extract(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`), name)[0];

function loadHelpers() {
  // eslint-disable-next-line no-new-func
  return new Function(
    `${grab('escapeHtml')}\n${grab('nodeInnerHtml')}\n${grab('buildColumnsHtml')}\n` +
      'return { escapeHtml, nodeInnerHtml, buildColumnsHtml };'
  )();
}

function baseColumns() {
  return [
    {
      typeName: 'Project', title: 'Project', subtitle: '', color: '#0000FF', isNarrow: false,
      aliases: [
        { typeName: 'Project 1', color: '#FF0000' },
        { typeName: 'Project 2', color: null },
      ],
    },
    { typeName: 'Doel', title: 'Doel', subtitle: '', color: '#00AA00', isNarrow: false, aliases: [] },
  ];
}

describe('buildColumnsHtml groepeert en kleurt alias-elementen (DOEL-56)', () => {
  it('een alias-element wordt in de kolom van zijn basistype getoond, niet als onbekend type', () => {
    const { buildColumnsHtml } = loadHelpers();
    const details = {
      1: { code: 'P1', name: 'Basis-project', type: 'Project' },
      2: { code: 'PA1', name: 'Alias-project 1', type: 'Project 1' },
    };
    const html = buildColumnsHtml(details, baseColumns());
    // Beide elementen horen in de "Project"-kolom (data-key="Project"), er komt
    // geen aparte kolom of "onbekend type" voor het alias-type bij.
    const projectColMatch = html.match(/<div class="column[^"]*" data-key="Project" data-order="0">([\s\S]*?)<\/div>\s*<\/div>/);
    assert.ok(projectColMatch, 'Project-kolom niet gevonden in de gerenderde HTML');
    assert.match(projectColMatch[1], /data-id="P1"/);
    assert.match(projectColMatch[1], /data-id="PA1"/);
    assert.doesNotMatch(html, /data-key="Project 1"/, 'alias-type mag geen eigen kolom krijgen');
  });

  it('een alias met eigen kleur gebruikt die kleur, niet de kolomkleur', () => {
    const { buildColumnsHtml } = loadHelpers();
    const details = { 1: { code: 'PA1', name: 'Alias-project 1', type: 'Project 1' } };
    const html = buildColumnsHtml(details, baseColumns());
    assert.match(html, /data-id="PA1"[^>]*style="background:#FF0000;/);
  });

  it('een alias zonder eigen kleur (color: null) valt terug op de kolomkleur', () => {
    const { buildColumnsHtml } = loadHelpers();
    const details = { 1: { code: 'PA2', name: 'Alias-project 2', type: 'Project 2' } };
    const html = buildColumnsHtml(details, baseColumns());
    assert.match(html, /data-id="PA2"[^>]*style="background:#0000FF;/);
  });

  it('een basistype-element (geen alias) blijft gewoon de kolomkleur gebruiken', () => {
    const { buildColumnsHtml } = loadHelpers();
    const details = { 1: { code: 'P1', name: 'Basis-project', type: 'Project' } };
    const html = buildColumnsHtml(details, baseColumns());
    assert.match(html, /data-id="P1"[^>]*style="background:#0000FF;/);
  });

  it('een écht onbekend type (geen kolom, geen alias) wordt overgeslagen', () => {
    const { buildColumnsHtml } = loadHelpers();
    const details = { 1: { code: 'X1', name: 'Spookelement', type: 'Niet-bestaand-type' } };
    const html = buildColumnsHtml(details, baseColumns());
    assert.doesNotMatch(html, /data-id="X1"/);
  });
});

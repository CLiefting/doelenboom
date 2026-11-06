// Regressietest voor DOEL-136: elementen in een kolom groeperen per alias.
//
// buildColumnsHtml zet in elke kolom eerst het basistype en daarna elke alias
// in de volgorde van de kolomconfiguratie (col.aliases), met boven elke
// niet-lege aliasgroep een klein label. updateGroupLabels verbergt een label
// als zijn groep door filters/zoeken geen zichtbare vakken meer heeft.
//
// Net als tree-html-alias.test.mjs toetst dit het ECHTE bronbestand: de
// functies worden uit web/public/tree.html gehaald en in een kale sandbox
// uitgevoerd. updateGroupLabels draait tegen een minimale nep-DOM (alleen de
// paar DOM-eigenschappen die de functie gebruikt).
//
// Uitvoeren: node --test web/test/tree-html-groups.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(__dirname, '..', 'public', 'tree.html'), 'utf8');

const grab = (name) => {
  const m = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} niet gevonden in tree.html — is het hernoemd/verplaatst?`);
  return m[0];
};

function loadHelpers() {
  // eslint-disable-next-line no-new-func
  return new Function(
    ['escapeHtml', 'nodeInnerHtml', 'buildColumnsHtml', 'isNodeShown', 'updateGroupLabels'].map(grab).join('\n') +
      '\nreturn { buildColumnsHtml, updateGroupLabels };'
  )();
}

const col = (typeName, aliases = []) => ({ typeName, title: typeName, subtitle: '', color: '#0000FF', isNarrow: false, aliases });

function columnHtml(html, key) {
  const start = html.indexOf('data-key="' + key + '"');
  assert.ok(start >= 0, `kolom ${key} niet gevonden`);
  const next = html.indexOf('<div class="column', start);
  return html.slice(start, next === -1 ? undefined : next);
}

// Volgorde van vakken en labels in een kolom, als ['L:Voorziening', 'P1', ...].
function sequence(colHtml) {
  const out = [];
  const re = /<div class="(node|col-group-label)" data-(?:id|group)="([^"]*)"/g;
  let m;
  while ((m = re.exec(colHtml))) out.push(m[1] === 'node' ? m[2] : 'L:' + m[2]);
  return out;
}

describe('buildColumnsHtml groepeert per type (DOEL-136)', () => {
  it('eerst het basistype, dan de aliassen in configuratievolgorde; binnen een groep de bestaande volgorde', () => {
    const { buildColumnsHtml } = loadHelpers();
    // details in sort_order, typen bewust door elkaar
    const details = {
      a: { code: 'B1', name: 'b', type: 'Werkinstructie 2' },
      b: { code: 'P2', name: 'p', type: 'Project' },
      c: { code: 'V1', name: 'v', type: 'Voorziening' },
      d: { code: 'P1', name: 'p', type: 'Project' },
      e: { code: 'B0', name: 'b', type: 'Werkinstructie 2' },
    };
    const columns = [col('Project', [{ typeName: 'Voorziening', color: null }, { typeName: 'Werkinstructie 2', color: null }])];
    const html = buildColumnsHtml(details, columns);
    assert.deepEqual(sequence(columnHtml(html, 'Project')), ['P2', 'P1', 'L:Voorziening', 'V1', 'L:Werkinstructie 2', 'B1', 'B0']);
  });

  it('een kolom zonder aliassen krijgt geen labels (ziet eruit als vóór DOEL-136)', () => {
    const { buildColumnsHtml } = loadHelpers();
    const details = { a: { code: 'C1', name: 'c', type: 'Capability' }, b: { code: 'C2', name: 'c', type: 'Capability' } };
    const html = buildColumnsHtml(details, [col('Capability')]);
    assert.doesNotMatch(html, /col-group-label/);
    assert.deepEqual(sequence(columnHtml(html, 'Capability')), ['C1', 'C2']);
  });

  it('een alias zonder elementen krijgt geen label; alleen-alias-elementen geven geen leeg basislabel', () => {
    const { buildColumnsHtml } = loadHelpers();
    const columns = [col('Project', [{ typeName: 'Leeg', color: null }, { typeName: 'Voorziening', color: null }])];
    const html = buildColumnsHtml({ a: { code: 'V1', name: 'v', type: 'Voorziening' } }, columns);
    assert.deepEqual(sequence(columnHtml(html, 'Project')), ['L:Voorziening', 'V1']);
  });

  it('A03: typenaam in het label en in data-group wordt ge-escaped', () => {
    const { buildColumnsHtml } = loadHelpers();
    const evil = '"><img src=x onerror=alert(1)>';
    const columns = [col('Project', [{ typeName: evil, color: null }])];
    const html = buildColumnsHtml({ a: { code: 'X1', name: 'x', type: evil } }, columns);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });
});

// ---- minimale nep-DOM voor updateGroupLabels ----
function fakeEl(className, dataset = {}) {
  const classes = new Set(className.split(' '));
  return {
    dataset,
    classList: {
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
    has: (c) => classes.has(c),
  };
}
function fakeColumn(items) {
  const wrap = {
    children: items,
    querySelectorAll: (sel) => (sel === '.node' ? items.filter((i) => i.classList.contains('node')) : []),
  };
  return { querySelectorAll: (sel) => (sel === '.col-nodes' ? [wrap] : []) };
}
const node = (id, group, extra = '') => fakeEl(('node ' + extra).trim(), { id, group });
const label = (group) => fakeEl('col-group-label', { group });

describe('updateGroupLabels (DOEL-136)', () => {
  it('verbergt het label van een groep zonder zichtbare vakken', () => {
    const { updateGroupLabels } = loadHelpers();
    const lv = label('Voorziening');
    const root = fakeColumn([node('P1', 'Project'), lv, node('V1', 'Voorziening', 'filter-hidden')]);
    updateGroupLabels(root);
    assert.ok(lv.has('group-empty'));
  });

  it('toont het label weer zodra er een vak zichtbaar is', () => {
    const { updateGroupLabels } = loadHelpers();
    const lv = label('Voorziening');
    const v1 = node('V1', 'Voorziening', 'node-hidden');
    const root = fakeColumn([node('P1', 'Project'), lv, v1]);
    updateGroupLabels(root);
    assert.ok(lv.has('group-empty'));
    v1.classList.toggle('node-hidden', false);
    updateGroupLabels(root);
    assert.ok(!lv.has('group-empty'));
    assert.ok(!lv.has('group-first'), 'boven het label staat een zichtbaar vak: gewone tussenruimte');
  });

  it('een label zonder zichtbare vakken erboven krijgt group-first (geen extra ruimte bovenaan)', () => {
    const { updateGroupLabels } = loadHelpers();
    const lv = label('Voorziening');
    const lw = label('Werkinstructie');
    const root = fakeColumn([node('P1', 'Project', 'filter-hidden'), lv, node('V1', 'Voorziening'), lw, node('W1', 'Werkinstructie')]);
    updateGroupLabels(root);
    assert.ok(lv.has('group-first'));
    assert.ok(!lw.has('group-first'));
    assert.ok(!lv.has('group-empty') && !lw.has('group-empty'));
  });
});

describe('verplaatsen kiest alleen uit de eigen groep (DOEL-136)', () => {
  it('columnCodesOf filtert op data-group', () => {
    const body = source.match(/function columnCodesOf\(code\) \{[\s\S]*?\n {2}\}/);
    assert.ok(body, 'columnCodesOf niet gevonden');
    assert.match(body[0], /dataset\.group === node\.dataset\.group/);
  });
});

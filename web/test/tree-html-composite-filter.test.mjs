// Regressietest voor DOEL-141: boomfilter en focusmodus bij samengestelde
// elementen (DOEL-140) in web/public/tree.html.
//
// Toetst het ECHTE bronbestand: filterKeepSet/focusKeepSet worden uit
// tree.html gehaald en in een kale sandbox uitgevoerd (zelfde opzet als
// tree-html-composite.test.mjs).
//
// Uitvoeren: node --test web/test/tree-html-composite-filter.test.mjs

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
const NAMES = ['compositionIndex', 'filterKeepSet', 'focusKeepSet'];
// eslint-disable-next-line no-new-func
const H = new Function(NAMES.map(grab).join('\n') + `\nreturn { ${NAMES.join(', ')} };`)();

// De boom uit de melding (acceptatie, 06-11-2026):
//   V3 → V4 → PB1.1 ⊂ PB1 → V6 → SD1
//              PB1.2 ⊂ PB1
//   V4 → V5 → V6
//   X1 → PB1.2
const details = Object.fromEntries([
  ['V3'], ['V4'], ['V5'], ['V6'], ['SD1'], ['X1'],
  ['PB1'], ['PB1.1', 'PB1'], ['PB1.2', 'PB1'],
].map(([code, partOf = null]) => [code, { code, partOf }]));
const edge = (source, target) => ({ source, target });
const edges = [
  edge('V3', 'V4'), edge('V4', 'PB1.1'), edge('V4', 'V5'), edge('V5', 'V6'),
  edge('PB1', 'V6'), edge('V6', 'SD1'), edge('X1', 'PB1.2'),
];
const sorted = (set) => [...set].sort();

describe('boomfilter (DOEL-141)', () => {
  it('filter op een deel zonder eigen relatie naar rechts volgt de keten van het geheel', () => {
    const keep = H.filterKeepSet(edges, details, ['PB1.1']);
    for (const c of ['PB1.1', 'PB1', 'V6', 'SD1', 'V4', 'V3']) assert.ok(keep.has(c), c + ' ontbreekt');
    assert.ok(!keep.has('PB1.2'), 'zusterdeel hoort er niet bij');
    assert.ok(!keep.has('X1'), 'keten van het zusterdeel hoort er niet bij');
  });

  it('filter op een element onder een deel loopt via het geheel door naar boven', () => {
    const keep = H.filterKeepSet(edges, details, ['V3']);
    for (const c of ['V3', 'V4', 'PB1.1', 'PB1', 'V5', 'V6', 'SD1']) assert.ok(keep.has(c), c + ' ontbreekt');
    assert.ok(!keep.has('PB1.2') && !keep.has('X1'));
  });

  it('filter op een geheel neemt zijn delen en wat die ondersteunt mee', () => {
    const keep = H.filterKeepSet(edges, details, ['PB1']);
    assert.deepEqual(sorted(keep), sorted(['PB1', 'PB1.1', 'PB1.2', 'V4', 'V3', 'X1', 'V6', 'SD1']));
    assert.ok(!keep.has('V5'), 'V5 ondersteunt PB1 niet');
  });

  it('filter vanaf boven bereikt via het geheel de delen en hun ondersteuning', () => {
    const keep = H.filterKeepSet(edges, details, ['SD1']);
    for (const c of ['SD1', 'V6', 'PB1', 'PB1.1', 'PB1.2', 'V4', 'V3', 'X1', 'V5']) assert.ok(keep.has(c), c + ' ontbreekt');
  });

  it('zonder samengestelde elementen gedraagt het filter zich als voorheen', () => {
    const plain = { A: { code: 'A' }, B: { code: 'B' }, C: { code: 'C' }, D: { code: 'D' } };
    const keep = H.filterKeepSet([edge('A', 'B'), edge('B', 'C'), edge('D', 'C')], plain, ['B']);
    assert.deepEqual(sorted(keep), ['A', 'B', 'C']);
  });

  it('kringen en een verwijzing naar een onbekend geheel laten het filter niet vastlopen', () => {
    const d = { A: { code: 'A', partOf: 'ZZ' }, B: { code: 'B', partOf: 'B' } };
    const keep = H.filterKeepSet([edge('A', 'B'), edge('B', 'A')], d, ['A']);
    assert.deepEqual(sorted(keep), ['A', 'B']);
  });
});

describe('focusmodus (DOEL-141)', () => {
  it('focus op een deel toont het niveau boven het geheel', () => {
    const keep = H.focusKeepSet(edges, details, 'PB1.1');
    for (const c of ['PB1.1', 'PB1', 'V6', 'V4', 'V3']) assert.ok(keep.has(c), c + ' ontbreekt');
    assert.ok(!keep.has('SD1'), 'maar één niveau omhoog');
    assert.ok(!keep.has('PB1.2'), 'zusterdeel hoort er niet bij');
  });

  it('focus op een geheel toont zijn delen en wat die ondersteunt', () => {
    const keep = H.focusKeepSet(edges, details, 'PB1');
    assert.deepEqual(sorted(keep), sorted(['PB1', 'PB1.1', 'PB1.2', 'V4', 'V3', 'X1', 'V6']));
  });

  it('is het element erboven een geheel, dan komen zijn delen erbij (zonder hun keten)', () => {
    const keep = H.focusKeepSet(edges, details, 'X1');
    assert.deepEqual(sorted(keep), sorted(['X1', 'PB1.2', 'PB1']));
    const keep2 = H.focusKeepSet([edge('Q', 'PB1')], { ...details, Q: { code: 'Q' } }, 'Q');
    assert.deepEqual(sorted(keep2), sorted(['Q', 'PB1', 'PB1.1', 'PB1.2']));
  });
});

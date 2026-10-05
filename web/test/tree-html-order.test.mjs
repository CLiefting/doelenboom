// Regressietests voor de volgorde van elementen in web/public/tree.html:
// DOEL-85 (kolom sorteren, alleen admin) en DOEL-86 (element verplaatsen).
// De serverkant — inclusief DOEL-84, nieuw element op codevolgorde — is
// getest in api/test/elementsOrder.test.ts. Zelfde aanpak als
// tree-html-bulk-select.test.mjs: de ECHTE functies uit het uitgeleverde
// bestand laden, plus structurele controles op de brontekst (geen jsdom).
//
// Uitvoeren: node --test web/test/tree-html-order.test.mjs

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
const NAMES = ['columnPositionOf', 'elementMoveButtonsHtml', 'moveAfterOptionsHtml', 'columnSortResultText'];
// eslint-disable-next-line no-new-func
const F = new Function([grab('escapeHtml'), ...NAMES.map(grab)].join('\n') + `\nreturn { ${NAMES.join(', ')} };`)();
const dom = extract(
  /\/\/ ---- Volgorde binnen een kolom \(DOEL-85 kolom sorteren, DOEL-86 element\n[\s\S]*?\n  \/\/ ---- Bulkacties op de selectie/,
  'DOM-blok van de volgorde'
)[0];
const XSS = '<img src=x onerror=alert(1)><script>alert(2)</script>"\'>';
const noRawHtml = (html) => assert.doesNotMatch(html, /<img|<script|onerror=alert\(1\)>/i);

describe('DOEL-86 verplaatsknoppen in het detailpaneel', () => {
  it('columnPositionOf geeft de plek en het aantal in de kolom', () => {
    assert.deepEqual(F.columnPositionOf(['C1', 'C2', 'C3'], 'C2'), { index: 1, count: 3 });
    assert.deepEqual(F.columnPositionOf(['C1'], 'X'), { index: -1, count: 1 });
    assert.deepEqual(F.columnPositionOf(undefined, 'X'), { index: -1, count: 0 });
  });

  it('omhoog uit op de bovenste plek, omlaag uit op de onderste; in het midden allebei aan', () => {
    const disabled = (html, dir) => new RegExp(`data-move="${dir}"[^>]*\\sdisabled>`).test(html);
    const top = F.elementMoveButtonsHtml('C1', { index: 0, count: 3 });
    const mid = F.elementMoveButtonsHtml('C2', { index: 1, count: 3 });
    const bottom = F.elementMoveButtonsHtml('C3', { index: 2, count: 3 });
    assert.deepEqual([disabled(top, 'up'), disabled(top, 'down')], [true, false]);
    assert.deepEqual([disabled(mid, 'up'), disabled(mid, 'down')], [false, false]);
    assert.deepEqual([disabled(bottom, 'up'), disabled(bottom, 'down')], [false, true]);
    assert.match(mid, /plek 2 van 3/);
    assert.match(mid, /dp-move-after-btn/);
  });

  it('geen knoppen als er niets te verplaatsen valt (één element, of element niet in een kolom)', () => {
    assert.equal(F.elementMoveButtonsHtml('C1', { index: 0, count: 1 }), '');
    assert.equal(F.elementMoveButtonsHtml('C1', { index: -1, count: 4 }), '');
    assert.equal(F.elementMoveButtonsHtml('C1', undefined), '');
  });

  it('"Plaats na…": bovenaan plus de andere elementen, zonder het element zelf; huidige plek voorgeselecteerd', () => {
    const details = { C1: { name: 'Een' }, C2: { name: 'Twee' }, C3: { name: 'Drie' } };
    const html = F.moveAfterOptionsHtml(['C1', 'C2', 'C3'], details, 'C2');
    assert.equal((html.match(/<option /g) || []).length, 3);
    assert.doesNotMatch(html, /value="C2"/);
    assert.match(html, /<option value="C1" selected>Na C1 — Een<\/option>/);
    assert.match(F.moveAfterOptionsHtml(['C1', 'C2'], details, 'C1'), /<option value="" selected>Bovenaan de kolom<\/option>/);
  });

  it('A03: code en naam worden ge-escaped in knoppen en keuzelijst', () => {
    noRawHtml(F.elementMoveButtonsHtml(XSS, { index: 1, count: 3 }));
    noRawHtml(F.moveAfterOptionsHtml(['C1', XSS], { [XSS]: { name: XSS }, C1: { name: XSS } }, 'C1'));
  });

  it('de knoppen staan binnen de crud-only-acties van het detailpaneel en lopen via onDetailAreaClick', () => {
    extract(/'<div class="dp-crud-actions crud-only">' \+\n(?:\s*\/\/[^\n]*\n)*\s*elementMoveButtonsHtml\(d\.code, columnPositionOf\(columnCodesOf\(d\.code\), d\.code\)\) \+/, 'knoppen in dp-crud-actions');
    extract(/const moveBtn = ev\.target\.closest\('\.dp-move-btn'\);\n    if \(moveBtn\) \{ moveElementInColumn\(moveBtn\.dataset\.code, \{ direction: moveBtn\.dataset\.move \}, moveBtn\); return; \}/, 'klikafhandeling omhoog/omlaag');
    extract(/const moveAfterBtn = ev\.target\.closest\('\.dp-move-after-btn'\);/, 'klikafhandeling "Plaats na…"');
  });
});

describe('DOEL-85 kolom sorteren', () => {
  it('melding na het sorteren: aantal verplaatst, of dat de kolom al goed stond', () => {
    assert.equal(F.columnSortResultText({ sorted: 4, moved: 0 }), 'De kolom stond al in deze volgorde.');
    assert.equal(F.columnSortResultText({ sorted: 4, moved: 2 }), 'Kolom gesorteerd: 2 van de 4 elementen verplaatst.');
    assert.equal(F.columnSortResultText({ sorted: 1, moved: 1 }), 'Kolom gesorteerd: 1 van de 1 element verplaatst.');
    assert.equal(F.columnSortResultText(undefined), 'De kolom stond al in deze volgorde.');
    assert.equal(F.columnSortResultText({ sorted: '<b>', moved: '<i>' }), 'De kolom stond al in deze volgorde.');
  });

  it('A01: de sorteerknop is admin-only en de dialoog opent niet voor een andere rol (UI; de API is de grens)', () => {
    extract(/sortBtn\.className = 'col-sort-btn admin-only';/, 'admin-only op de sorteerknop');
    extract(/body:not\(\.role-admin\) \.admin-only \{ display: none !important; \}/, 'CSS-regel voor admin-only');
    assert.match(dom, /function openColumnSortModal\(columnKey\) \{\n    if \(userRole !== 'admin' \|\| !TYPE_TO_COLUMN\[columnKey\]\) return;/);
  });

  it('de browser stuurt alleen kolom en sorteerwijze; de sorteerwijzen zijn een vaste lijst', () => {
    assert.match(dom, /postBulk\('sort-column', \{ column: columnSortKey, by: chosen \? chosen\.value : 'code' \}\)/);
    const html = extract(/<div class="element-modal-backdrop" id="column-sort-modal-backdrop">[\s\S]*?id="column-sort-save"[^\n]*/, 'sorteerdialoog')[0];
    assert.deepEqual((html.match(/name="column-sort-by" value="[a-z]+"/g) || []).map((m) => m.split('value=')[1]), ['"code"', '"parent"']);
  });

  it('de sorteerknop verstoort het bestaande gedrag van de kolomkop niet', () => {
    // Eigen klik (geen kolomselectie in selectiemodus) en geen kolomsamenvatting bij dubbelklik.
    extract(/sortBtn\.addEventListener\('click', \(e\) => \{\n      e\.stopPropagation\(\);\n      openColumnSortModal\(col\.dataset\.key\);/, 'stopPropagation op de sorteerknop');
    extract(/if \(ev\.target\.closest\('\.col-hide-btn, \.col-sort-btn'\)\) return;/, 'dblclick-uitzondering');
    // De SVG-export leest alleen de eerste tekstknoop van de kolomkop.
    extract(/t\.textContent = header\.childNodes\[0\] \? header\.childNodes\[0\]\.textContent\.trim\(\) : '';/, 'SVG-export kolomkop');
  });
});

describe('DOEL-85/86 A03: het DOM-blok', () => {
  it('meldingen via textContent; HTML alleen via de ge-teste functie; geen inline handlers', () => {
    const code = dom.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
    const assignments = code.match(/\.innerHTML = [^\n]*/g) || [];
    assert.deepEqual(assignments, ['.innerHTML = moveAfterOptionsHtml(codes, DETAILS, code);']);
    assert.match(code, /columnSortTitle\.textContent = /);
    assert.match(code, /moveAfterTitle\.textContent = /);
    assert.match(code, /CSS\.escape\(code\)/);
    assert.match(code, /encodeURIComponent\(code\) \+ '\/move'/);
    assert.doesNotMatch(code, /insertAdjacentHTML|outerHTML|document\.write|eval\(/);
    const html = extract(/<div class="element-modal-backdrop" id="column-sort-modal-backdrop">[\s\S]*?id="move-after-save"[^\n]*/, 'dialoog-HTML')[0];
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  });
});

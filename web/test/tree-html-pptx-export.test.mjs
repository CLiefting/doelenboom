// Regressietests voor het dialoogvenster "Exporteer als PowerPoint" in
// web/public/tree.html (DOEL-88). De serverkant is getest in
// api/test/exportPptx.test.ts, de presentatie zelf in
// excel-service/tests/test_tree_pptx.py. Zelfde aanpak als
// tree-html-order.test.mjs: de ECHTE functies uit het uitgeleverde bestand
// laden, plus structurele controles op de brontekst (geen jsdom).
//
// Uitvoeren: node --test web/test/tree-html-pptx-export.test.mjs

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
const NAMES = [
  'pptxExportClampPerRow', 'pptxExportColumnRows', 'pptxExportSlideCount', 'pptxExportSummaryText',
  'pptxExportColumnsHtml', 'pptxExportPayload',
];
const consts = extract(/const PPTX_EXPORT_MAX_SLIDES = \d+;\nconst PPTX_EXPORT_SNOER_MAX_ROWS = \d+;/, 'grenzen')[0];
// eslint-disable-next-line no-new-func
const F = new Function(
  [consts, grab('escapeHtml'), ...NAMES.map(grab)].join('\n') +
  `\nreturn { PPTX_EXPORT_MAX_SLIDES, PPTX_EXPORT_SNOER_MAX_ROWS, ${NAMES.join(', ')} };`
)();
const dom = extract(
  /\/\/ ---- PowerPoint-export van de doelenboom \(DOEL-88\) ----\n  \/\/ De keuzes[\s\S]*?\n  \/\/ ---- Excel-export/,
  'DOM-blok van de PowerPoint-export'
)[0];
const modal = extract(/<div class="element-modal-backdrop" id="pptx-export-modal-backdrop">[\s\S]*?<\/form>/, 'dialoogvenster')[0];
const XSS = '<img src=x onerror=alert(1)><script>alert(2)</script>"\'>';

const COLUMNS = [
  { typeName: 'Project', title: 'Project', color: '#3E6FA6' },
  { typeName: 'Capability', title: 'Capability', color: '#6B4C8A' },
  { typeName: 'Benefit', title: 'Benefit CLPK', color: '#C05A2C' },
  { typeName: 'Missie', title: '', color: 'geen-kleur' },
];
const rows = () => F.pptxExportColumnRows(COLUMNS, ['Capability'], { Project: 11, Capability: 4, Benefit: 1 });

describe('DOEL-88 kolommen in het dialoogvenster', () => {
  it('rijen volgen de kolomvolgorde, met aantal, verborgen-vlag en veilige kleur', () => {
    assert.deepEqual(rows(), [
      { typeName: 'Project', title: 'Project', color: '#3E6FA6', count: 11, hidden: false },
      { typeName: 'Capability', title: 'Capability', color: '#6B4C8A', count: 4, hidden: true },
      { typeName: 'Benefit', title: 'Benefit CLPK', color: '#C05A2C', count: 1, hidden: false },
      { typeName: 'Missie', title: 'Missie', color: '#999999', count: 0, hidden: false },
    ]);
    assert.deepEqual(F.pptxExportColumnRows(undefined, undefined, undefined), []);
  });

  it('een verborgen kolom is uitgeschakeld en nooit aangevinkt', () => {
    const html = F.pptxExportColumnsHtml(rows(), ['Capability', 'Benefit']);
    assert.match(html, /value="Capability" disabled>/);
    assert.match(html, /is-hidden/);
    assert.match(html, /value="Benefit" checked>/);
    assert.doesNotMatch(html, /value="Project"[^>]*checked/);
    assert.match(html, />verborgen</);
    assert.match(html, />11 elementen</);
    assert.match(html, />1 element</);
  });

  it('lege kolomlijst geeft een nette melding', () => {
    assert.match(F.pptxExportColumnsHtml([], []), /geen kolommen/);
  });

  it('XSS: kolomnaam, titel en kleur komen alleen ge-escaped in de HTML', () => {
    const evil = F.pptxExportColumnRows(
      [{ typeName: XSS, title: XSS, color: 'red;background:url(javascript:alert(1))' }], [], {}
    );
    assert.equal(evil[0].color, '#999999');
    const html = F.pptxExportColumnsHtml(evil, [XSS]);
    assert.doesNotMatch(html, /<img|<script|javascript:/i);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });
});

describe('DOEL-88 aantal slides (zelfde telling als de server)', () => {
  it('zonder aangevinkte kolommen alleen het overzicht', () => {
    assert.equal(F.pptxExportSlideCount(rows(), [], 4), 1);
  });

  it('per aangevinkte kolom een tussenslide plus een slide per element', () => {
    assert.equal(F.pptxExportSlideCount(rows(), ['Project'], 4), 1 + 1 + 11);
    assert.equal(F.pptxExportSlideCount(rows(), ['Project', 'Benefit', 'Missie'], 4), 1 + 12 + 2 + 1);
  });

  it('een verborgen kolom telt niet mee, ook niet als hij toch in de lijst staat', () => {
    assert.equal(F.pptxExportSlideCount(rows(), ['Capability'], 4), 1);
  });

  it('het overzicht loopt door op een vervolgslide bij meer dan vier regels', () => {
    const many = F.pptxExportColumnRows(Array.from({ length: 11 }, (_, i) => ({ typeName: 'K' + i })), [], {});
    assert.equal(F.pptxExportSlideCount(many, [], 2), 2); // 6 regels
    assert.equal(F.pptxExportSlideCount(many, [], 3), 1); // 4 regels
  });

  it('kolommen per regel wordt begrensd op 2 tot en met 6', () => {
    assert.equal(F.pptxExportClampPerRow('4'), 4);
    assert.equal(F.pptxExportClampPerRow(1), 2);
    assert.equal(F.pptxExportClampPerRow(99), 6);
    assert.equal(F.pptxExportClampPerRow('abc'), 4);
    assert.equal(F.pptxExportClampPerRow(undefined), 4);
  });

  it('samenvatting noemt het aantal en waarschuwt boven het maximum', () => {
    assert.equal(F.pptxExportSummaryText(1, 300), 'Dit worden 1 slide (alleen het overzicht van de kolommen).');
    assert.equal(F.pptxExportSummaryText(14, 300), 'Dit worden 14 slides.');
    assert.equal(F.pptxExportSummaryText(300, 300), 'Dit worden 300 slides.');
    assert.match(F.pptxExportSummaryText(301, 300), /maximum is 300/);
  });

  it('de grenzen zijn dezelfde als op de server', () => {
    assert.equal(F.PPTX_EXPORT_MAX_SLIDES, 300);
    assert.equal(F.PPTX_EXPORT_SNOER_MAX_ROWS, 4);
  });
});

describe('DOEL-88 wat er naar de server gaat', () => {
  it('alleen zichtbare kolommen, in kolomvolgorde; verborgen kolommen nooit', () => {
    assert.deepEqual(F.pptxExportPayload(rows(), ['Missie', 'Capability', 'Project'], '3'), {
      visibleColumns: ['Project', 'Benefit', 'Missie'],
      slideColumns: ['Project', 'Missie'],
      perRow: 3,
    });
  });

  it('onbekende namen en een ongeldige waarde voor kolommen per regel vallen weg', () => {
    assert.deepEqual(F.pptxExportPayload(rows(), ['Bestaat niet', XSS], 'veel'), {
      visibleColumns: ['Project', 'Benefit', 'Missie'], slideColumns: [], perRow: 4,
    });
  });
});

describe('DOEL-88 structuur in de pagina', () => {
  it('menu-item staat in het Bestand-menu en is niet beperkt tot beheerders of bewerkers', () => {
    const item = extract(/<button[^>]*id="export-pptx-btn"[^>]*>[^<]*<\/button>/, 'menu-item')[0];
    assert.match(item, /Exporteer als PowerPoint/);
    assert.doesNotMatch(item, /admin-only|crud-only/);
    const menu = extract(/<div class="file-menu-dropdown" id="file-menu-dropdown">[\s\S]*?<\/div>\s*<\/div>/, 'Bestand-menu')[0];
    assert.match(menu, /id="export-pptx-btn"/);
  });

  it('dialoogvenster heeft de kolomlijst, kolommen per regel (2-6, standaard 4) en de samenvatting', () => {
    assert.match(modal, /id="pptx-export-columns"/);
    assert.match(modal, /id="pptx-export-summary"/);
    const options = [...modal.matchAll(/<option value="(\d)"( selected)?>/g)].map((m) => m[1] + (m[2] ? '*' : ''));
    assert.deepEqual(options, ['2', '3', '4*', '5', '6']);
  });

  it('het verzoek gaat met het token naar de export-route van deze boom', () => {
    assert.match(dom, /'\/api\/doelenbomen\/' \+ doelenboomId \+ '\/export-pptx'/);
    assert.match(dom, /method: 'POST'/);
    assert.match(dom, /Authorization: 'Bearer ' \+ authToken/);
    assert.match(dom, /pptxExportPayload\(pptxExportRows, pptxExportChecked\(\), pptxExportPerRowEl\.value\)/);
  });

  it('de kolomlijst wordt alleen via de escapende hulpfunctie opgebouwd; meldingen via textContent', () => {
    const code = dom.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const assignments = [...code.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.deepEqual(assignments, ['pptxExportColumnsHtml(pptxExportRows, [])']);
    assert.match(code, /pptxExportSummaryEl\.textContent = /);
    assert.doesNotMatch(code, /insertAdjacentHTML|document\.write|eval\(/);
  });

  it('verborgen kolommen komen uit de huidige weergave en de knop gaat uit boven het maximum', () => {
    assert.match(dom, /pptxExportColumnRows\(COLUMNS, Array\.from\(hiddenCols\), counts\)/);
    assert.match(dom, /count > PPTX_EXPORT_MAX_SLIDES/);
    assert.match(dom, /pptxExportSaveBtn\.disabled = tooMany/);
  });

  it('een dubbele klik start geen tweede export', () => {
    assert.match(dom, /if \(pptxExportBusy\) return;/);
  });
});

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
  'pptxExportColumnsHtml', 'pptxExportPayload', 'pptxExportCounts', 'pptxExportFilterText',
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
  it('zonder aangevinkte kolommen alleen het snoer en de totale boom (DOEL-103)', () => {
    assert.equal(F.pptxExportSlideCount(rows(), [], 4), 2);
  });

  it('per aangevinkte kolom een tussenslide plus een slide per element', () => {
    assert.equal(F.pptxExportSlideCount(rows(), ['Project'], 4), 2 + 1 + 11);
    assert.equal(F.pptxExportSlideCount(rows(), ['Project', 'Benefit', 'Missie'], 4), 2 + 12 + 2 + 1);
  });

  it('een verborgen kolom telt niet mee, ook niet als hij toch in de lijst staat', () => {
    assert.equal(F.pptxExportSlideCount(rows(), ['Capability'], 4), 2);
  });

  it('het overzicht loopt door op een vervolgslide bij meer dan vier regels', () => {
    const many = F.pptxExportColumnRows(Array.from({ length: 11 }, (_, i) => ({ typeName: 'K' + i })), [], {});
    assert.equal(F.pptxExportSlideCount(many, [], 2), 3); // 6 regels: 2 snoerslides + de totale boom
    assert.equal(F.pptxExportSlideCount(many, [], 3), 2); // 4 regels
  });

  it('kolommen per regel wordt begrensd op 2 tot en met 6', () => {
    assert.equal(F.pptxExportClampPerRow('4'), 4);
    assert.equal(F.pptxExportClampPerRow(1), 2);
    assert.equal(F.pptxExportClampPerRow(99), 6);
    assert.equal(F.pptxExportClampPerRow('abc'), 4);
    assert.equal(F.pptxExportClampPerRow(undefined), 4);
  });

  it('samenvatting noemt het aantal en waarschuwt boven het maximum', () => {
    assert.equal(F.pptxExportSummaryText(2, 300), 'Dit worden 2 slides (alleen de kolommen en de totale boom).');
    assert.equal(F.pptxExportSummaryText(3, 300), 'Dit worden 3 slides.');
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

describe('DOEL-107 Boomfilter in de PowerPoint-export', () => {
  const TYPES = { P1: 'Project', P2: 'Project', P3: 'Deelproject', C1: 'Capability', B1: 'Benefit', Z1: 'Onbekend' };
  const TYPE_TO_COLUMN = { Project: 'Project', Deelproject: 'Project', Capability: 'Capability', Benefit: 'Benefit' };

  it('aantallen per kolom: hele boom, met aliassen bij hun kolom en onbekende types niet geteld', () => {
    assert.deepEqual(F.pptxExportCounts(TYPES, TYPE_TO_COLUMN, null), { Project: 3, Capability: 1, Benefit: 1 });
    assert.deepEqual(F.pptxExportCounts(undefined, undefined, undefined), {});
  });

  it('aantallen per kolom: met een Boomfilter alleen de gefilterde elementen', () => {
    assert.deepEqual(F.pptxExportCounts(TYPES, TYPE_TO_COLUMN, ['P1', 'P3', 'B1', 'BESTAAT-NIET']), { Project: 2, Benefit: 1 });
    assert.deepEqual(F.pptxExportCounts(TYPES, TYPE_TO_COLUMN, []), {});
  });

  it('de slidetelling volgt de gefilterde aantallen', () => {
    const all = F.pptxExportColumnRows(COLUMNS, [], F.pptxExportCounts(TYPES, TYPE_TO_COLUMN, null));
    const filtered = F.pptxExportColumnRows(COLUMNS, [], F.pptxExportCounts(TYPES, TYPE_TO_COLUMN, ['P1', 'B1']));
    assert.equal(F.pptxExportSlideCount(all, ['Project'], 4), 2 + 1 + 3);
    assert.equal(F.pptxExportSlideCount(filtered, ['Project'], 4), 2 + 1 + 1);
  });

  it('tekst bij het vinkje noemt het aantal', () => {
    assert.equal(F.pptxExportFilterText(32), 'Alleen de gefilterde boom (32 elementen)');
    assert.equal(F.pptxExportFilterText(1), 'Alleen de gefilterde boom (1 element)');
  });

  it('zonder filter gaan er geen filtervelden naar de server', () => {
    for (const none of [null, undefined, {}, { picks: ['P1'] }, { visibleElements: 'P1' }]) {
      assert.deepEqual(Object.keys(F.pptxExportPayload(rows(), [], 4, none)), ['visibleColumns', 'slideColumns', 'perRow']);
    }
  });

  it('met filter gaan de codes ontdubbeld mee; keuzes buiten het filter en niet-tekst vallen weg', () => {
    const payload = F.pptxExportPayload(rows(), ['Project'], 4, {
      visibleElements: ['P1', 'B1', 'P1', '', 7, null], picks: ['B1', 'C1', 'B1'],
    });
    assert.deepEqual(payload.visibleElements, ['P1', 'B1']);
    assert.deepEqual(payload.filterPicks, ['B1']);
    assert.deepEqual(payload.slideColumns, ['Project']);
    assert.deepEqual(F.pptxExportPayload(rows(), [], 4, { visibleElements: ['P1'] }).filterPicks, []);
  });

  it('het venster heeft een vinkje dat standaard aan staat en alleen bij een Boomfilter zichtbaar is', () => {
    assert.match(modal, /id="pptx-export-filter-row" style="display:none;"/);
    assert.match(modal, /<input type="checkbox" id="pptx-export-filter" checked>/);
    assert.match(dom, /pptxExportFilterEl\.checked = true;/);
    assert.match(dom, /pptxExportFilterRow\.style\.display = pptxExportFilter \? '' : 'none';/);
  });

  it('alleen het Boomfilter telt: de stand komt uit elementFilterActive en filterKeepIds, niet uit focus of dimmen', () => {
    assert.match(dom, /pptxExportFilter = elementFilterActive && filterKeepIds\s*\? \{ visibleElements: Array\.from\(filterKeepIds\), picks: Array\.from\(filterSelection\) \}\s*: null;/);
    const code = dom.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /focusId|dimmed|lastChipFilterMatchIds/);
  });

  it('uitvinken exporteert de hele boom en de tekst van het vinkje gaat via textContent', () => {
    assert.match(dom, /return pptxExportFilter && pptxExportFilterEl\.checked \? pptxExportFilter : null;/);
    assert.match(dom, /pptxExportFilterTextEl\.textContent = /);
    assert.match(dom, /pptxExportFilterEl\.addEventListener\('change'/);
  });
});

// Draait het echte DOM-blok uit tree.html tegen een minimale nep-DOM, zodat het
// samenspel (venster openen, vinkje, aantallen, wat er naar de server gaat)
// wordt uitgevoerd in plaats van alleen op tekst gecontroleerd.
function runDialog({ filterActive, keep, picks }) {
  const made = {};
  const el = (id) => {
    if (!made[id]) {
      const handlers = {};
      made[id] = {
        id, style: {}, value: id === 'pptx-export-per-row' ? '4' : '', checked: false, disabled: false,
        textContent: '', innerHTML: '', handlers,
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(type, fn) { handlers[type] = fn; },
        querySelectorAll(selector) {
          const boxes = [...this.innerHTML.matchAll(/<input type="checkbox" value="([^"]*)"( disabled| checked)?>/g)]
            .map((m) => ({ value: m[1], checked: m[2] === ' checked', disabled: m[2] === ' disabled' }));
          if (selector.includes(':checked')) return boxes.filter((b) => b.checked);
          return boxes.filter((b) => !b.disabled);
        },
      };
    }
    return made[id];
  };
  const sent = [];
  const env = {
    document: { getElementById: el, createElement: () => ({ click() {} }), body: { appendChild() {}, removeChild() {} } },
    DETAILS: { P1: { type: 'Project' }, P2: { type: 'Project' }, C1: { type: 'Capability' }, B1: { type: 'Benefit' }, B2: { type: 'Benefit' } },
    TYPE_TO_COLUMN: { Project: COLUMNS[0], Capability: COLUMNS[1], Benefit: COLUMNS[2], Missie: COLUMNS[3] },
    COLUMNS, hiddenCols: new Set(),
    elementFilterActive: filterActive, filterKeepIds: keep ? new Set(keep) : null, filterSelection: new Set(picks || []),
    focusId: null,
    setBulkStatus() {}, showToast() {}, apiUrl: '', doelenboomId: 7, authToken: 't',
    fetch: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: false, status: 500, json: async () => ({}) }; },
    URL: { createObjectURL: () => '', revokeObjectURL() {} }, setTimeout: () => 0,
    ...F,
  };
  // eslint-disable-next-line no-new-func
  new Function(...Object.keys(env), dom)(...Object.values(env));
  const check = (name) => {
    const cols = el('pptx-export-columns');
    cols.innerHTML = cols.innerHTML.replace(`value="${name}">`, `value="${name}" checked>`);
    cols.handlers.change();
  };
  return {
    el, sent, check,
    open: () => el('export-pptx-btn').handlers.click(),
    submit: () => el('pptx-export-form').handlers.submit({ preventDefault() {} }),
  };
}

describe('DOEL-107 gedrag van het exportvenster (DOM-blok uitgevoerd)', () => {
  it('zonder Boomfilter: geen vinkje, aantallen van de hele boom en geen filtervelden in het verzoek', async () => {
    const d = runDialog({ filterActive: false, keep: null, picks: [] });
    d.open();
    assert.equal(d.el('pptx-export-filter-row').style.display, 'none');
    assert.match(d.el('pptx-export-columns').innerHTML, />2 elementen</);
    d.check('Project');
    assert.equal(d.el('pptx-export-summary').textContent, 'Dit worden 5 slides.'); // snoer + boom + tussenslide + 2
    await d.submit();
    assert.deepEqual(d.sent[0].body, { visibleColumns: ['Project', 'Capability', 'Benefit', 'Missie'], slideColumns: ['Project'], perRow: 4 });
  });

  it('met Boomfilter: vinkje zichtbaar en aan, gefilterde aantallen, en het filter gaat mee', async () => {
    const d = runDialog({ filterActive: true, keep: ['P1', 'C1', 'B1'], picks: ['B1'] });
    d.open();
    assert.equal(d.el('pptx-export-filter-row').style.display, '');
    assert.equal(d.el('pptx-export-filter').checked, true);
    assert.equal(d.el('pptx-export-filter-text').textContent, 'Alleen de gefilterde boom (3 elementen)');
    assert.doesNotMatch(d.el('pptx-export-columns').innerHTML, />2 elementen</);
    d.check('Project');
    assert.equal(d.el('pptx-export-summary').textContent, 'Dit worden 4 slides.'); // snoer + boom + tussenslide + P1
    await d.submit();
    assert.equal(d.sent[0].url, '/api/doelenbomen/7/export-pptx');
    assert.deepEqual(d.sent[0].body.visibleElements, ['P1', 'C1', 'B1']);
    assert.deepEqual(d.sent[0].body.filterPicks, ['B1']);
  });

  it('vinkje uit: weer de hele boom, de aangevinkte kolom blijft aangevinkt en er gaat geen filter mee', async () => {
    const d = runDialog({ filterActive: true, keep: ['P1', 'C1', 'B1'], picks: ['B1'] });
    d.open();
    d.check('Project');
    d.el('pptx-export-filter').checked = false;
    d.el('pptx-export-filter').handlers.change();
    assert.match(d.el('pptx-export-columns').innerHTML, /value="Project" checked>/);
    assert.match(d.el('pptx-export-columns').innerHTML, />2 elementen</);
    assert.equal(d.el('pptx-export-summary').textContent, 'Dit worden 5 slides.');
    await d.submit();
    assert.deepEqual(Object.keys(d.sent[0].body), ['visibleColumns', 'slideColumns', 'perRow']);
  });

  it('opnieuw openen zet het vinkje weer aan', () => {
    const d = runDialog({ filterActive: true, keep: ['P1'], picks: ['P1'] });
    d.open();
    d.el('pptx-export-filter').checked = false;
    d.open();
    assert.equal(d.el('pptx-export-filter').checked, true);
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
    assert.match(dom, /pptxExportPayload\(pptxExportRows, pptxExportChecked\(\), pptxExportPerRowEl\.value, pptxExportActiveFilter\(\)\)/);
  });

  it('de kolomlijst wordt alleen via de escapende hulpfunctie opgebouwd; meldingen via textContent', () => {
    const code = dom.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const assignments = [...code.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.deepEqual(assignments, ['pptxExportColumnsHtml(pptxExportRows, checkedNames)']);
    assert.match(code, /pptxExportSummaryEl\.textContent = /);
    assert.doesNotMatch(code, /insertAdjacentHTML|document\.write|eval\(/);
  });

  it('verborgen kolommen komen uit de huidige weergave en de knop gaat uit boven het maximum', () => {
    assert.match(dom, /pptxExportColumnRows\(COLUMNS, Array\.from\(hiddenCols\), counts\)/);
    assert.match(dom, /pptxExportCounts\(types, typeToColumn, active \? active\.visibleElements : null\)/);
    assert.match(dom, /count > PPTX_EXPORT_MAX_SLIDES/);
    assert.match(dom, /pptxExportSaveBtn\.disabled = tooMany/);
  });

  it('een dubbele klik start geen tweede export', () => {
    assert.match(dom, /if \(pptxExportBusy\) return;/);
  });
});

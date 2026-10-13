// Regressietests voor het dialoogvenster "Programma als PowerPoint" in
// web/public/tree.html (DOEL-112). De serverkant is getest in
// api/test/programPptx.test.ts, de presentatie zelf in
// excel-service/tests/test_program_pptx.py. Zelfde aanpak als
// tree-html-pptx-export.test.mjs: de ECHTE functies uit het uitgeleverde
// bestand laden, plus structurele controles op de brontekst (geen jsdom).
//
// Uitvoeren: node --test web/test/tree-html-program-pptx.test.mjs

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
  'programPptxProjectRows', 'programPptxRagColor', 'programPptxProjectsHtml', 'programPptxSummaryText',
  'programPptxWindowOptionsHtml', 'programPptxClampWindow', 'programPptxPayload', 'programPptxApplySelection',
  'programPptxSelectionOptionsHtml', 'programPptxLocalIsoDate',
];
const consts = extract(/const PROGRAM_PPTX_MAX_PROJECTS = \d+;\nconst PROGRAM_PPTX_WINDOW_DEFAULT = \d+;/, 'grenzen')[0];
// eslint-disable-next-line no-new-func
const F = new Function(
  [consts, grab('escapeHtml'), ...NAMES.map(grab)].join('\n') +
  `\nreturn { PROGRAM_PPTX_MAX_PROJECTS, PROGRAM_PPTX_WINDOW_DEFAULT, ${NAMES.join(', ')} };`
)();
const dom = extract(/\/\/ ---- Programma-PowerPoint \(DOEL-112\) ----\n  \/\/ Meerdere projecten[\s\S]*?\n  \/\/ ---- Element-CRUD/, 'DOM-blok')[0];
const modal = extract(/<div class="element-modal-backdrop" id="program-pptx-modal-backdrop">[\s\S]*?<\/form>/, 'dialoogvenster')[0];
const XSS = '<img src=x onerror=alert(1)><script>alert(2)</script>"\'>';

const ROWS = () => F.programPptxProjectRows([
  { code: 'P1', name: 'Zeta', rag: 'Groen' },
  { code: 'P2', name: 'alfa', rag: 'ROOD' },
  { code: 'P3', name: 'Beta' },
  { code: '', name: 'zonder code' },
  null,
]);

describe('DOEL-112 projectenlijst', () => {
  it('alfabetisch (hoofdletterongevoelig), zonder lege codes, RAG in kleine letters', () => {
    assert.deepEqual(ROWS(), [
      { code: 'P2', name: 'alfa', rag: 'rood' },
      { code: 'P3', name: 'Beta', rag: '' },
      { code: 'P1', name: 'Zeta', rag: 'groen' },
    ]);
    assert.deepEqual(F.programPptxProjectRows(undefined), []);
  });

  it('HTML: aangevinkt volgens de keuze en een RAG-kleur per project', () => {
    const html = F.programPptxProjectsHtml(ROWS(), ['P1']);
    assert.match(html, /value="P1" checked>/);
    assert.doesNotMatch(html, /value="P2" checked/);
    assert.match(html, /background:#DC3545/);
    assert.match(html, /background:#B5BAC2/);
    assert.match(F.programPptxProjectsHtml([], []), /geen projecten/);
  });

  it('XSS: projectnaam en -code komen alleen ge-escaped in de HTML; RAG kan geen CSS injecteren', () => {
    const rows = F.programPptxProjectRows([{ code: XSS, name: XSS, rag: 'red;background:url(javascript:alert(1))' }]);
    const html = F.programPptxProjectsHtml(rows, [XSS]);
    assert.doesNotMatch(html, /<img|<script|javascript:/);
    assert.match(html, /&lt;img/);
  });
});

describe('DOEL-112 keuzes en payload', () => {
  it('samenvatting en grenzen', () => {
    assert.equal(F.programPptxSummaryText(0), 'Kies minstens één project.');
    assert.equal(F.programPptxSummaryText(1), '1 project gekozen.');
    assert.equal(F.programPptxSummaryText(3), '3 projecten gekozen.');
    assert.match(F.programPptxSummaryText(F.PROGRAM_PPTX_MAX_PROJECTS + 1), /maximum is 50/);
  });

  it('venster: 12 opties, standaard 3, en geklemd tussen 1 en 12', () => {
    const html = F.programPptxWindowOptionsHtml(3);
    assert.equal((html.match(/<option/g) || []).length, 12);
    assert.match(html, /value="3" selected>Komende 3 maanden/);
    assert.match(html, />Komende 1 maand</);
    assert.equal(F.programPptxClampWindow('0'), 1);
    assert.equal(F.programPptxClampWindow('99'), 12);
    assert.equal(F.programPptxClampWindow('x'), 3);
  });

  it('payload: alleen bekende codes in lijstvolgorde, geldige peildatum, geklemd venster', () => {
    assert.deepEqual(
      F.programPptxPayload(ROWS(), ['P1', 'P2', 'ONBEKEND', 'P1'], '2026-10-13', '6'),
      { projects: ['P2', 'P1'], windowMonths: 6, referenceDate: '2026-10-13' }
    );
    assert.deepEqual(F.programPptxPayload(ROWS(), [], 'gisteren', '99'), { projects: [], windowMonths: 12 });
  });

  it('peildatum standaard vandaag in lokale tijd', () => {
    assert.equal(F.programPptxLocalIsoDate(new Date(2026, 0, 5)), '2026-01-05');
  });
});

describe('DOEL-112 opgeslagen selecties', () => {
  it('toepassen laat verdwenen projecten weg en telt ze', () => {
    assert.deepEqual(F.programPptxApplySelection({ projectCodes: ['P1', 'WEG', 'P3'] }, ROWS()), { codes: ['P1', 'P3'], missing: 1 });
    assert.deepEqual(F.programPptxApplySelection(null, ROWS()), { codes: [], missing: 0 });
  });

  it('keuzelijst: lege optie eerst, gekozen selectie geselecteerd, namen ge-escaped', () => {
    const html = F.programPptxSelectionOptionsHtml([{ id: 4, name: 'Stuurgroep' }, { id: 7, name: XSS }], '4');
    assert.match(html, /^<option value="">/);
    assert.match(html, /value="4" selected>Stuurgroep</);
    assert.doesNotMatch(html, /<img|<script/);
  });
});

describe('DOEL-112 structuur', () => {
  it('menu-item is standaard verborgen en wordt alleen met module Projecten getoond (niet standalone)', () => {
    assert.match(source, /id="export-program-pptx-btn" style="display:none;"/);
    assert.match(dom, /if \(programPptxBtn && programPptxBackdrop && projectenActive && !document\.body\.classList\.contains\('standalone'\)\)/);
  });

  it('venster heeft de velden: selectie, projecten, peildatum, venster, naam', () => {
    for (const id of ['program-pptx-selection', 'program-pptx-projects', 'program-pptx-ref', 'program-pptx-window', 'program-pptx-selection-name']) {
      assert.match(modal, new RegExp(`id="${id}"`), id);
    }
    assert.match(modal, /maxlength="80"/);
  });

  it('DOM-blok zet geen gebruikersinvoer via innerHTML zonder de ge-escapete helpers', () => {
    const assignments = dom.match(/\.innerHTML = [^;]+;/g) || [];
    assert.ok(assignments.length > 0);
    for (const a of assignments) assert.match(a, /programPptx(ProjectsHtml|WindowOptionsHtml|SelectionOptionsHtml)\(/, a);
    // Geen eval/new Function en selectie-id's gaan ge-encodeerd de URL in.
    assert.doesNotMatch(dom, /eval\(|new Function/);
    assert.match(dom, /encodeURIComponent\(selectedId\)/);
  });
});

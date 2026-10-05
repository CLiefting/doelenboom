// Regressietests voor DOEL-80: Selectiemodus (meerdere elementen selecteren)
// in web/public/tree.html. Zelfde aanpak als tree-html-attributes.test.mjs:
// de ECHTE functies uit het uitgeleverde bestand halen en los uitvoeren, plus
// structurele controles op de brontekst (geen jsdom). OWASP A01 (knop en balk
// alleen voor schrijfrollen) en A03 (geen gebruikersinvoer als markup).
//
// Uitvoeren: node --test web/test/tree-html-bulk-select.test.mjs

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

const NAMES = ['bulkSelectionToggle', 'bulkSelectionAdd', 'bulkSelectionStatusText'];
// eslint-disable-next-line no-new-func
const F = new Function(NAMES.map(grab).join('\n') + `\nreturn { ${NAMES.join(', ')} };`)();

// Het DOM-deel van de selectiemodus (binnen runApp).
const block = extract(
  /\/\/ ---- Selectiemodus \(DOEL-80\): meerdere elementen aanklikken[\s\S]*?\n  \/\/ Ctrl\/Cmd-klik \(Boomfilter-pick\)/,
  'Selectiemodus-blok'
)[0];

describe('DOEL-80 hulpfuncties voor de selectie', () => {
  it('bulkSelectionToggle zet een code aan en weer uit', () => {
    const sel = new Set();
    F.bulkSelectionToggle(sel, 'P1');
    assert.deepEqual([...sel], ['P1']);
    F.bulkSelectionToggle(sel, 'C1');
    F.bulkSelectionToggle(sel, 'P1');
    assert.deepEqual([...sel], ['C1']);
  });

  it('bulkSelectionAdd voegt alleen bestaande elementcodes toe en telt wat nieuw is', () => {
    const known = { P1: {}, P2: {}, C1: {} };
    const sel = new Set(['P1']);
    const added = F.bulkSelectionAdd(sel, ['P1', 'P2', 'ONBEKEND', 'C1', 'P2'], known);
    assert.equal(added, 2);
    assert.deepEqual([...sel].sort(), ['C1', 'P1', 'P2']);
  });

  it('bulkSelectionAdd negeert niet-strings, prototype-sleutels en een ontbrekende lijst', () => {
    const known = { P1: {} };
    const sel = new Set();
    assert.equal(F.bulkSelectionAdd(sel, [1, null, undefined, {}, '__proto__', 'constructor', 'toString'], known), 0);
    assert.equal(F.bulkSelectionAdd(sel, undefined, known), 0);
    assert.equal(F.bulkSelectionAdd(sel, 'P1', known), 0);
    assert.equal(F.bulkSelectionAdd(sel, ['P1'], undefined), 0);
    assert.equal(sel.size, 0);
  });

  it('bulkSelectionStatusText: uitleg bij een lege selectie, enkelvoud/meervoud, niet-zichtbaar', () => {
    assert.match(F.bulkSelectionStatusText(0, 0), /^Selectiemodus actief/);
    assert.equal(F.bulkSelectionStatusText(1, 0), '1 element geselecteerd');
    assert.equal(F.bulkSelectionStatusText(7, 0), '7 elementen geselecteerd');
    assert.equal(F.bulkSelectionStatusText(7, 2), '7 elementen geselecteerd (waarvan 2 nu niet zichtbaar)');
  });
});

describe('DOEL-80 A01: selectiemodus alleen voor schrijfrollen (UI; de API blijft de grens)', () => {
  it('knop en statusbalk zijn crud-only (verborgen bij body.read-only)', () => {
    extract(/<button class="[^"]*\bcrud-only\b[^"]*" id="select-mode-btn"/, 'crud-only op #select-mode-btn');
    extract(/<span class="[^"]*\bcrud-only\b[^"]*" id="select-status"/, 'crud-only op #select-status');
    extract(/body\.read-only \.crud-only \{ display: none !important; \}/, 'CSS-regel voor crud-only');
  });

  it('het selectiemodus-blok doet zelf geen API-aanroepen', () => {
    assert.doesNotMatch(block, /fetch\(/);
  });
});

describe('DOEL-80 A03: geen gebruikersinvoer als markup, geen inline handlers', () => {
  it('de statusbalk wordt met textContent gevuld en het blok gebruikt nergens innerHTML', () => {
    assert.match(block, /selectStatusTextEl\.textContent = bulkSelectionStatusText\(/);
    // Commentaarregels tellen niet mee: daar staat juist uitgelegd dát er geen innerHTML is.
    const code = block.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
    assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  });

  it('elementcodes gaan via CSS.escape een selector in', () => {
    const selectors = block.match(/querySelector\('\.node\[data-id="' \+ [^)]*\)/g) || [];
    assert.ok(selectors.length >= 2, 'verwacht minstens twee data-id-selectors in het blok');
    selectors.forEach((s) => assert.match(s, /CSS\.escape\(id\)/));
  });

  it('de nieuwe HTML bevat geen inline event-handlers', () => {
    const html = extract(/<span class="select-status crud-only" id="select-status">[\s\S]*?\n    <\/span>/, 'statusbalk-HTML')[0];
    const btn = extract(/<button class="btn ghost crud-only" id="select-mode-btn"[^>]*>/, 'knop-HTML')[0];
    assert.doesNotMatch(html + btn, /\son[a-z]+\s*=/i);
  });
});

describe('DOEL-80 samenspel met bestaand klikgedrag', () => {
  it('Selectiemodus en Verbindmodus sluiten elkaar uit', () => {
    extract(/function setConnectMode\(on\) \{\n    if \(on && selectMode\) setSelectMode\(false\);/, 'uitsluiting in setConnectMode');
    assert.match(block, /function setSelectMode\(on\) \{\n    if \(on && focusId !== null\) return;\n    if \(on && connectMode\) setConnectMode\(false\);/);
  });

  it('Boomfilter-pick (Ctrl/Cmd-klik, lang indrukken) en dubbelklik-zoom staan uit in selectiemodus', () => {
    extract(/if \(!node \|\| connectMode \|\| selectMode\) return;\n    if \(ev\.metaKey \|\| ev\.ctrlKey\) toggleFilterPick/, 'mousedown-guard');
    extract(/if \(!node \|\| selectMode\) return;[^\n]*\n    clearTimeout\(longPressTimer\);/, 'touchstart-guard');
    extract(/if \(!node \|\| connectMode \|\| selectMode\) return;[^\n]*\n    enterFocus\(node\);/, 'dblclick-guard');
  });

  it('focusmodus beëindigt de selectiemodus en de modus start niet in focusmodus', () => {
    extract(/function enterFocus\(node, returnTarget\) \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(selectMode\) setSelectMode\(false\);/, 'enterFocus beëindigt selectiemodus');
    assert.match(block, /function toggleBulkPick\(id\) \{\n    if \(focusId !== null\) return;/);
  });

  it('de SVG-export neemt het vinkje (en het Verbindmodus-volgnummer) niet mee in de vaktekst', () => {
    extract(/clone\.querySelectorAll\('[^']*\.node-connect-badge, \.node-bulk-badge'\)\.forEach\(el => el\.remove\(\)\)/, 'nodeTextLines');
  });
});

// ---------------------------------------------------------------------------
// DOEL-81 (bulk-bewerken) en DOEL-82 (bulk-verwijderen): de dialogen die op
// de selectie werken. De serverkant is getest in api/test/elementsBulk.test.ts.
// ---------------------------------------------------------------------------
const grabLine = (name) => extract(new RegExp(`const ${name} = [^\\n]*;`), name)[0];
const BULK = [
  'bulkNaturalCompare', 'bulkCommonAttributes', 'bulkLinkRowsHtml', 'bulkAttributeRowsHtml', 'bulkEditBuildPayload',
  'bulkDeleteImpact', 'bulkDeleteSummaryText', 'bulkDeleteListHtml', 'bulkDeleteConfirmMatches',
];
const DEPS = ['escapeHtml', 'attributesForType', 'attributeHasValue', 'attributeInputHtml'];
// eslint-disable-next-line no-new-func
const B = new Function(
  [grabLine('ATTRIBUTE_TEXT_MAX_LENGTH'), ...DEPS.map(grab), ...BULK.map(grab)].join('\n') + `\nreturn { ${BULK.join(', ')} };`
)();
const bulkDom = extract(
  /\/\/ ---- Bulkacties op de selectie \(DOEL-81 bewerken, DOEL-82 verwijderen\) ----\n  \/\/ De selectie zelf[\s\S]*?\n  \/\/ ---- Producten\/deliverables/,
  'DOM-blok van de bulkacties'
)[0];
const XSS = '<img src=x onerror=alert(1)><script>alert(2)</script>"\'>';
const noRawHtml = (html) => assert.doesNotMatch(html, /<img|<script|onerror=alert\(1\)>/i);

describe('DOEL-81 bulk-bewerken: opbouw van het verzoek', () => {
  const none = { type: '', taakveldMode: '', subtaakveldMode: '', tags: [], orgUnits: [], attributes: [] };

  it('niets gekozen of "Instellen op" zonder waarde geeft een melding en geen verzoek', () => {
    assert.match(B.bulkEditBuildPayload(['P1'], none).error, /minstens één wijziging/);
    assert.match(B.bulkEditBuildPayload(['P1'], { ...none, taakveldMode: 'set', taakveld: '   ' }).error, /Taakveld/);
    assert.match(B.bulkEditBuildPayload(['P1'], { ...none, subtaakveldMode: 'set' }).error, /Sub-taakveld/);
  });

  it('alleen gekozen onderdelen komen in de body; "Leegmaken" stuurt een lege tekst', () => {
    const r = B.bulkEditBuildPayload(['P1', 'P2'], { ...none, taakveldMode: 'set', taakveld: ' IT ', subtaakveldMode: 'clear' });
    assert.deepEqual(r.payload, { codes: ['P1', 'P2'], set: { taakveld: 'IT', subtaakveld: '' } });
    assert.equal(r.summary.length, 2);
    const onlyType = B.bulkEditBuildPayload(['P1'], { ...none, type: 'Capability' });
    assert.deepEqual(onlyType.payload, { codes: ['P1'], set: { type: 'Capability' } });
  });

  it('tags, organisatieonderdelen en kenmerken; null = kenmerk wissen', () => {
    const r = B.bulkEditBuildPayload(['P1'], {
      ...none,
      tags: [{ code: 'TA', mode: 'add', name: 'Tag A' }, { code: 'TB', mode: 'remove', name: 'Tag B' }, { code: 'TC', mode: '', name: 'Tag C' }],
      orgUnits: [{ code: 'OA', mode: 'add', name: 'Org A' }],
      attributes: [{ id: 'K1', label: 'Fase', value: 'Hoog', display: 'Hoog' }, { id: 'K2', label: 'Referentie', value: null, display: '' }],
    });
    assert.deepEqual(r.payload, {
      codes: ['P1'],
      tags: { add: ['TA'], remove: ['TB'] },
      orgUnits: { add: ['OA'], remove: [] },
      attributes: { K1: 'Hoog', K2: null },
    });
    assert.equal(r.summary.length, 5);
    assert.ok(r.summary.some((line) => /Referentie.*gewist/.test(line)));
  });

  it('de body bevat nooit code, naam, omschrijving of KPI van een element', () => {
    const r = B.bulkEditBuildPayload(['P1'], { ...none, type: 'Project', code: 'X', name: 'X', description: 'X', kpi: 'X' });
    assert.deepEqual(Object.keys(r.payload).sort(), ['codes', 'set']);
    assert.deepEqual(Object.keys(r.payload.set), ['type']);
  });

  it('bulkCommonAttributes: alleen kenmerken die voor elk type gelden; een alias volgt zijn basistype', () => {
    const defs = [
      { id: 'K1', subjectTypes: ['Capability', 'Project'] },
      { id: 'K2', subjectTypes: ['Capability'] },
    ];
    const ids = (types, base) => B.bulkCommonAttributes(defs, types, base || {}).map((d) => d.id);
    assert.deepEqual(ids(['Capability', 'Project']), ['K1']);
    assert.deepEqual(ids(['Capability']), ['K1', 'K2']);
    assert.deepEqual(ids(['Capability', 'Cap-alias'], { 'Cap-alias': 'Capability' }), ['K1', 'K2']);
    assert.deepEqual(ids([]), []);
  });
});

describe('DOEL-81/82 A03: namen, codes en waarden worden ge-escaped', () => {
  it('tag-/organisatierijen: naam en code ge-escaped; keuzes volgen het aantal koppelingen', () => {
    const html = B.bulkLinkRowsHtml([{ code: XSS, name: XSS }, { code: 'TA', name: 'Tag A' }, { code: 'TB', name: 'Tag B' }], { TA: 3, TB: 1 }, 3);
    noRawHtml(html);
    const options = (code) => (html.split(`data-code="${code}"`)[1] || '').split('</select>')[0];
    assert.doesNotMatch(options('TA'), /value="add"/);
    assert.match(options('TA'), /value="remove"/);
    assert.match(options('TB'), /value="add"/);
    assert.match(options('TB'), /value="remove"/);
    assert.match(html, /1 van 3/);
    assert.match(B.bulkLinkRowsHtml([], {}, 3), /Nog geen items/);
  });

  it('kenmerkrijen: label, id en keuzelijstwaarden ge-escaped', () => {
    const html = B.bulkAttributeRowsHtml([
      { id: 'K1', label: XSS, kind: 'choice', options: [XSS, 'Laag'] },
      { id: 'K2', label: 'Referentie', kind: 'text' },
    ]);
    noRawHtml(html);
    assert.equal((html.match(/class="bulk-attr-check"/g) || []).length, 2);
    assert.match(html, /bulk-attr-input-wrap" hidden/);
  });

  it('verwijderlijst: code, naam en type ge-escaped', () => {
    const html = B.bulkDeleteListHtml([XSS, 'P1'], { [XSS]: { name: XSS, type: XSS }, P1: { name: 'Project een', type: 'Project' } });
    noRawHtml(html);
    assert.match(html, /<strong>P1<\/strong> Project een/);
  });

  it('het DOM-blok zet meldingen met textContent en bouwt HTML alleen via de ge-teste functies', () => {
    const code = bulkDom.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
    const assignments = code.match(/\.innerHTML = [^\n]*/g) || [];
    assert.ok(assignments.length >= 4);
    assignments.forEach((a) => assert.match(a, /bulkLinkRowsHtml\(|bulkDeleteListHtml\(|bulkAttributeRowsHtml\(|typeOptionsHtml|bulkEditAttrDefs\.length/, a));
    assert.match(code, /bulkDeleteSummary\.textContent = bulkDeleteSummaryText\(/);
    assert.doesNotMatch(code, /insertAdjacentHTML|outerHTML|document\.write|eval\(/);
    const html = extract(/<div class="element-modal-backdrop" id="bulk-edit-modal-backdrop">[\s\S]*?id="bulk-delete-ok"[^\n]*/, 'dialoog-HTML')[0];
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  });
});

describe('DOEL-82 bulk-verwijderen: impact en bevestiging', () => {
  it('telt elke geraakte relatie één keer en de elementen met projectgegevens', () => {
    const edges = [{ source: 'P1', target: 'C1' }, { source: 'P2', target: 'C1' }, { source: 'P3', target: 'C2' }, { source: 'C1', target: 'M1' }];
    const impact = B.bulkDeleteImpact(['P1', 'C1', 'P1'], edges, { P1: [{}] }, { C1: [] }, { P9: {} });
    assert.deepEqual(impact, { count: 2, relations: 3, withProjectData: 1 });
    assert.deepEqual(B.bulkDeleteImpact(['P3'], edges, {}, { P3: [{}] }, {}), { count: 1, relations: 1, withProjectData: 1 });
  });

  it('samenvatting: enkelvoud/meervoud en projectgegevens alleen als ze er zijn', () => {
    const one = B.bulkDeleteSummaryText({ count: 1, relations: 1, withProjectData: 0 });
    assert.match(one, /1 element te verwijderen/);
    assert.match(one, /verdwijnt ook 1 relatie/);
    assert.doesNotMatch(one, /projectgegevens/);
    const many = B.bulkDeleteSummaryText({ count: 5, relations: 0, withProjectData: 2 });
    assert.match(many, /5 elementen/);
    assert.match(many, /verdwijnen ook 0 relaties/);
    assert.match(many, /Bij 2 ervan/);
  });

  it('bevestigen kan alleen door exact het aantal over te typen', () => {
    assert.equal(B.bulkDeleteConfirmMatches('12', 12), true);
    assert.equal(B.bulkDeleteConfirmMatches(' 12 ', 12), true);
    for (const wrong of ['', '1', '120', '12.0', 'twaalf', '012', null, undefined]) {
      assert.equal(B.bulkDeleteConfirmMatches(wrong, 12), false, String(wrong));
    }
    assert.equal(B.bulkDeleteConfirmMatches('0', 0), false);
  });

  it('A01: de knop Verwijderen is admin-only en de dialoog opent niet voor een andere rol; de knop start uitgeschakeld', () => {
    extract(/<button class="[^"]*\badmin-only\b[^"]*" id="select-delete-btn"[^>]*disabled>/, 'admin-only op #select-delete-btn');
    extract(/body:not\(\.role-admin\) \.admin-only \{ display: none !important; \}/, 'CSS-regel voor admin-only');
    assert.match(bulkDom, /function openBulkDeleteModal\(\) \{\n    if \(userRole !== 'admin'\) return;/);
    extract(/id="bulk-delete-ok" disabled>/, 'bevestigknop start uitgeschakeld');
    assert.match(bulkDom, /if \(!codes\.length \|\| !bulkDeleteConfirmMatches\(bulkDeleteInput\.value, codes\.length\)\) return;/);
  });

  it('natuurlijke sortering van codes (B10 na B9)', () => {
    assert.deepEqual(['B10', 'B9', 'B1', 'A2'].sort(B.bulkNaturalCompare), ['A2', 'B1', 'B9', 'B10']);
  });
});

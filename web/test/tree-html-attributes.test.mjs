// Regressietests voor DOEL-76 (epic DOEL-61): kenmerken per element in
// web/public/tree.html — sectie in het detailpaneel, invulformulier en
// hint-kaartje. Zelfde aanpak als tree-html-control-rules.test.mjs: de ECHTE
// functies uit het uitgeleverde bestand halen en los uitvoeren. Inclusief
// OWASP A03 (alle gebruikersinvoer ge-escaped, geen inline handlers).
//
// Uitvoeren: node --test web/test/tree-html-attributes.test.mjs

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
  return m[0];
}
const grab = (name) => extract(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`), name);
const grabLine = (name) => extract(new RegExp(`const ${name} = [^\\n]*;`), name);

const NAMES = [
  'attributesForType', 'attributeHasValue', 'attributeDisplayValue', 'attributeValueFromInput',
  'attributeInputHtml', 'attributesPanelHtml', 'attributesHintHtml',
];
// eslint-disable-next-line no-new-func
const F = new Function(
  [grab('escapeHtml'), grabLine('ATTRIBUTE_TEXT_MAX_LENGTH'), grabLine('ATTRIBUTE_HINT'), ...NAMES.map(grab)].join('\n') +
    `\nreturn { ${NAMES.join(', ')}, ATTRIBUTE_TEXT_MAX_LENGTH, ATTRIBUTE_HINT };`
)();

const XSS = '<img src=x onerror=alert(1)><script>alert(2)</script>"\'>';
const def = (o) => ({ id: 'K', label: 'Kenmerk', kind: 'text', subjectTypes: ['Capability'], required: false, explanation: '', options: [], ...o });
const DEFS = [
  def({ id: 'T1', label: 'Referentie' }),
  def({ id: 'N1', label: 'Aantal', kind: 'number' }),
  def({ id: 'D1', label: 'Laatst beoordeeld', kind: 'date', required: true }),
  def({ id: 'C1', label: 'Fase', kind: 'choice', options: ['Laag', 'Hoog'] }),
  def({ id: 'B1', label: 'Getoetst', kind: 'boolean' }),
];

// Geen tag of attribuut dat uit gebruikersinvoer is ontstaan: de payload mag
// alleen als ge-escapete tekst voorkomen.
function assertNoInjectedMarkup(html) {
  assert.doesNotMatch(html, /<img|<script|<svg/i);
  for (const tag of html.match(/<[^>]+>/g) ?? []) {
    // Attribuutwaarden tussen aanhalingstekens zijn ge-escapete tekst; alleen
    // een handler als ECHT attribuut telt.
    assert.doesNotMatch(tag.replace(/"[^"]*"/g, '""'), /\son[a-z]+\s*=/i, `inline handler in ${tag}`);
  }
}

describe('kenmerken in tree.html (DOEL-76)', () => {
  it('attributesForType: rechtstreeks op type, en een alias volgt zijn basistype', () => {
    const attrs = [def({ id: 'A' }), def({ id: 'B', subjectTypes: ['Project'] }), def({ id: 'C', subjectTypes: ['Variant'] })];
    const base = { Capability: 'Capability', Variant: 'Capability', Project: 'Project' };
    assert.deepEqual(F.attributesForType(attrs, 'Capability', base).map((a) => a.id), ['A']);
    assert.deepEqual(F.attributesForType(attrs, 'Variant', base).map((a) => a.id), ['A', 'C']);
    assert.deepEqual(F.attributesForType(attrs, 'Project', base).map((a) => a.id), ['B']);
    assert.deepEqual(F.attributesForType(attrs, 'Onbekend', base), []);
    assert.deepEqual(F.attributesForType(undefined, 'Capability', undefined), []);
  });

  it('attributeDisplayValue: ja/nee, datum DD-MM-JJJJ, decimale komma; 0 en nee zijn waarden', () => {
    assert.equal(F.attributeDisplayValue(DEFS[4], true), 'Ja');
    assert.equal(F.attributeDisplayValue(DEFS[4], false), 'Nee');
    assert.equal(F.attributeDisplayValue(DEFS[2], '2026-03-31'), '31-03-2026');
    assert.equal(F.attributeDisplayValue(DEFS[1], 12.5), '12,5');
    assert.equal(F.attributeDisplayValue(DEFS[1], 0), '0');
    assert.equal(F.attributeDisplayValue(DEFS[0], 'abc'), 'abc');
    for (const empty of [undefined, null, '']) assert.equal(F.attributeDisplayValue(DEFS[0], empty), '');
  });

  it('attributeValueFromInput: per soort, leeg = wissen, fouten met het label', () => {
    const [t, n, d, c, b] = DEFS;
    assert.deepEqual(F.attributeValueFromInput(t, '  abc  '), { value: 'abc' });
    assert.deepEqual(F.attributeValueFromInput(t, '   '), { value: null });
    assert.match(F.attributeValueFromInput(t, 'x'.repeat(201)).error, /Referentie: maximaal 200 tekens/);
    assert.deepEqual(F.attributeValueFromInput(t, 'x'.repeat(200)), { value: 'x'.repeat(200) });
    assert.deepEqual(F.attributeValueFromInput(n, '12,5'), { value: 12.5 });
    assert.deepEqual(F.attributeValueFromInput(n, '-3'), { value: -3 });
    assert.deepEqual(F.attributeValueFromInput(n, '0'), { value: 0 });
    assert.deepEqual(F.attributeValueFromInput(n, ''), { value: null });
    for (const bad of ['abc', '1e5', '1.2.3', '12,', '0x10', '1 000']) assert.match(F.attributeValueFromInput(n, bad).error, /Aantal: vul een getal in/, bad);
    for (const bad of ['1000000000000000', '0,1234567', '123456789012,123456']) assert.match(F.attributeValueFromInput(n, bad).error, /maximaal 15 cijfers/, bad);
    assert.deepEqual(F.attributeValueFromInput(d, '2026-03-31'), { value: '2026-03-31' });
    assert.match(F.attributeValueFromInput(d, '31-03-2026').error, /geldige datum/);
    assert.deepEqual(F.attributeValueFromInput(c, 'Hoog'), { value: 'Hoog' });
    assert.match(F.attributeValueFromInput(c, 'Anders').error, /Fase: kies een waarde uit de lijst/);
    assert.deepEqual(F.attributeValueFromInput(b, 'true'), { value: true });
    assert.deepEqual(F.attributeValueFromInput(b, 'false'), { value: false });
    assert.deepEqual(F.attributeValueFromInput(b, ''), { value: null });
    assert.match(F.attributeValueFromInput(b, 'ja').error, /kies ja, nee of niet ingevuld/);
  });

  it('detailpaneel: waarden per kenmerk, streepje bij leeg, "verplicht"-label; geen sectie zonder kenmerken', () => {
    assert.equal(F.attributesPanelHtml([], {}, { canEdit: true }), '');
    assert.equal(F.attributesPanelHtml(undefined, undefined, undefined), '');
    const html = F.attributesPanelHtml(DEFS, { T1: 'REF-1', N1: 0, C1: 'Hoog', B1: false }, { canEdit: false, elementCode: 'C1' });
    assert.match(html, /<div class="dp-attrs-title">Kenmerken<\/div>/);
    assert.match(html, /Referentie<\/span><span class="dp-attr-value">REF-1</);
    assert.match(html, /Aantal<\/span><span class="dp-attr-value">0</);
    assert.match(html, /Getoetst<\/span><span class="dp-attr-value">Nee</);
    // DOEL-78: verplicht als rode * achter het label, met een legenda eronder.
    assert.match(html, /<div class="dp-attr-row empty"><span class="dp-attr-label">Laatst beoordeeld <span class="dp-attr-req" title="Verplicht" aria-label="verplicht">\*<\/span><\/span><span class="dp-attr-value">&mdash;</);
    assert.match(html, /<div class="dp-attr-legend"><span class="dp-attr-req" aria-hidden="true">\*<\/span> verplicht<\/div>/);
    assert.equal((html.match(/dp-attr-req/g) ?? []).length, 2, 'één verplicht kenmerk + de legenda');
    assert.doesNotMatch(html, />verplicht<\/span>/, 'het oude label is weg');
    // Zonder verplichte kenmerken geen legenda; in het formulier dezelfde * en legenda.
    assert.doesNotMatch(F.attributesPanelHtml(DEFS.filter((a) => !a.required), {}, { canEdit: true }), /dp-attr-legend|dp-attr-req/);
    const form = F.attributesPanelHtml(DEFS, {}, { canEdit: true, elementCode: 'C1', editing: true });
    assert.match(form, /Laatst beoordeeld <span class="dp-attr-req" title="Verplicht" aria-label="verplicht">\*<\/span><\/label>/);
    assert.match(form, /dp-attr-legend/);
  });

  it('bezoeker (canEdit=false) krijgt geen knoppen en geen formulier, ook niet met editing=true', () => {
    for (const editing of [false, true]) {
      const html = F.attributesPanelHtml(DEFS, { T1: 'x' }, { canEdit: false, elementCode: 'C1', editing });
      assert.doesNotMatch(html, /<button|data-attr-action|<input|<select/);
    }
    const edit = F.attributesPanelHtml(DEFS, {}, { canEdit: true, elementCode: 'C1' });
    assert.match(edit, /<button type="button" class="btn ghost btn-sm dp-attr-btn" data-attr-action="edit" data-code="C1">Kenmerken bewerken<\/button>/);
  });

  it('formulier: één veld per soort met de huidige waarde, de hint, teller en Opslaan/Annuleren', () => {
    const html = F.attributesPanelHtml(DEFS, { T1: 'REF-1', N1: 12.5, D1: '2026-03-31', C1: 'Hoog', B1: false }, { canEdit: true, elementCode: 'C1', editing: true });
    assert.ok(html.includes(F.ATTRIBUTE_HINT));
    assert.match(F.ATTRIBUTE_HINT, /geen inhoudelijke of gerubriceerde informatie/);
    assert.match(html, /<input type="text" class="dp-attr-input dp-attr-text" autocomplete="off" maxlength="200" data-attr-id="T1" aria-label="Referentie" value="REF-1">/);
    assert.match(html, /<span class="dp-attr-counter">5 \/ 200<\/span>/);
    assert.match(html, /inputmode="decimal"[^>]*data-attr-id="N1"[^>]*value="12,5"/);
    assert.match(html, /<input type="date" class="dp-attr-input" data-attr-id="D1"[^>]*value="2026-03-31">/);
    assert.match(html, /<option value="Hoog" selected>Hoog<\/option>/);
    assert.match(html, /<option value="Laag">Laag<\/option>/);
    assert.match(html, /<option value="false" selected>Nee<\/option>/);
    assert.match(html, /data-attr-action="save" data-code="C1">Opslaan/);
    assert.match(html, /data-attr-action="cancel" data-code="C1">Annuleren/);
    // Leeg formulier: niets voorgeselecteerd.
    const empty = F.attributesPanelHtml(DEFS, {}, { canEdit: true, elementCode: 'C1', editing: true });
    assert.doesNotMatch(empty, / selected/);
    assert.match(empty, /<span class="dp-attr-counter">0 \/ 200<\/span>/);
  });

  it('hint-kaartje: alleen ingevulde kenmerken; niets als alles leeg is', () => {
    assert.equal(F.attributesHintHtml(DEFS, {}), '');
    assert.equal(F.attributesHintHtml(DEFS, undefined), '');
    assert.equal(F.attributesHintHtml([], { T1: 'x' }), '');
    const html = F.attributesHintHtml(DEFS, { T1: 'REF-1', D1: '2026-03-31', B1: false, N1: 0 });
    assert.match(html, /<b>Referentie:<\/b> REF-1/);
    assert.match(html, /<b>Laatst beoordeeld:<\/b> 31-03-2026/);
    assert.match(html, /<b>Getoetst:<\/b> Nee/);
    assert.match(html, /<b>Aantal:<\/b> 0/);
    assert.doesNotMatch(html, /Fase/);
  });

  it('A03: label, uitleg, keuzelijstwaarden, tekstwaarden, id en elementcode worden overal ge-escaped', () => {
    const defs = [
      def({ id: 'X1', label: XSS, explanation: XSS }),
      def({ id: 'X2', label: `Keuze ${XSS}`, kind: 'choice', options: [XSS, 'Gewoon'] }),
      def({ id: '"><img src=x>', label: 'Vreemd id' }),
    ];
    const values = { X1: XSS, X2: XSS, '"><img src=x>': XSS };
    const outputs = [
      F.attributesPanelHtml(defs, values, { canEdit: true, elementCode: XSS }),
      F.attributesPanelHtml(defs, values, { canEdit: true, elementCode: XSS, editing: true }),
      F.attributesPanelHtml(defs, values, { canEdit: false, elementCode: XSS }),
      F.attributesHintHtml(defs, values),
    ];
    for (const html of outputs) {
      assertNoInjectedMarkup(html);
      assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'payload staat er als tekst');
    }
    // Een waarde kan niet uit een attribuut breken.
    assert.match(outputs[1], /value="&lt;img src=x onerror=alert\(1\)&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;&quot;&#39;&gt;"/);
  });

  it('A03/CSP: de kenmerkfuncties bevatten geen inline handlers of eval', () => {
    const code = NAMES.map(grab).join('\n') + extract(/async function handleAttributeAction\(btn\) \{[\s\S]*?\n  \}/, 'handleAttributeAction');
    assert.doesNotMatch(code, /\son[a-z]+\s*=\s*["'\\]/i);
    assert.doesNotMatch(code, /\beval\s*\(|new Function\s*\(|javascript:/);
  });

  it('detailpaneel en hint gebruiken de functies; bewerken loopt via onDetailAreaClick; export en SVG ongemoeid', () => {
    assert.match(source, /attributesPanelHtml\(attributeDefsFor\(id\), ATTRIBUTE_VALUES\[id\], \{\s*canEdit: userRole !== 'bezoeker' && !document\.body\.classList\.contains\('standalone'\),/);
    assert.match(source, /attributesHintHtml\(attributeDefsFor\(node\.dataset\.id\), ATTRIBUTE_VALUES\[node\.dataset\.id\]\)/);
    assert.match(source, /const attrBtn = ev\.target\.closest\('\[data-attr-action\]'\);\s*if \(attrBtn\) \{ handleAttributeAction\(attrBtn\); return; \}/);
    assert.match(source, /body\.read-only \.dp-attr-actions \{ display: none; \}/);
    // De statische HTML-export neemt de boomrespons over (dus ook de kenmerken);
    // alleen de motivaties van afwijkingen worden daar vervangen.
    const exportFn = extract(/function exportStaticHtml\(\) \{[\s\S]*?\n  \}/, 'exportStaticHtml');
    assert.match(exportFn, /Object\.assign\(\{\}, lastTreeResponse, \{\s*controlRuleDeviations:/);
    assert.doesNotMatch(exportFn, /attributeValues|attributes:/);
  });
});

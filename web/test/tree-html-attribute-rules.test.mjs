// Regressietests voor DOEL-77 (epic DOEL-61): controleregels op kenmerken in
// web/public/tree.html — de ingebouwde regel voor een verplicht kenmerk
// (req-<kenmerk-id>) en het regeltype "Kenmerk voldoet aan…"
// (attribute_condition). Zelfde aanpak als tree-html-control-rules.test.mjs:
// de ECHTE functies uit het uitgeleverde bestand halen en los uitvoeren.
// "Vandaag" gaat als parameter mee, zodat datumeisen deterministisch te testen
// zijn. Inclusief OWASP A03 en de prestatiemeting uit het ticket.
//
// Uitvoeren: node --test web/test/tree-html-attribute-rules.test.mjs

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
const grabConst = (name) => extract(new RegExp(`const ${name} = \\{[^\\n]*\\};`), name);
const grabLine = (name) => extract(new RegExp(`const ${name} = [^\\n]*;`), name);

const NAMES = [
  'escapeHtml', 'controlRuleTypeList', 'controlDeviationKey', 'attributeHasValue', 'attributeDisplayValue',
  'localTodayIso', 'attributeDayNumber', 'attributeRequirementText', 'attributeConditionHolds', 'attributeConditionViolation',
  'evaluateControlRules', 'controlViolationsAllMotivated', 'controlDeviationMetaText', 'controlRuleTooltipText',
  'controlRuleHintHtml', 'controlRuleDeviationFormHtml', 'controlRuleViolationsHtml', 'controlRulesSummaryHtml',
];
// eslint-disable-next-line no-new-func
const F = new Function(
  [
    grabConst('CONTROL_RULE_FIELD_LABELS'), grabConst('CONTROL_RULE_FIELD_KEYS'),
    grabLine('CONTROL_DEVIATION_MAX_LENGTH'), grabLine('CONTROL_DEVIATION_HINT'), grabLine('REQUIRED_RULE_PREFIX'),
    ...NAMES.map(grab),
  ].join('\n') + `\nreturn { ${NAMES.join(', ')} };`
)();

const TODAY = '2026-10-03';
const TYPE_TO_BASE = { Capability: 'Capability', Variant: 'Capability', Project: 'Project' };
const def = (o) => ({ id: 'K', label: 'Kenmerk', kind: 'text', subjectTypes: ['Capability'], required: false, explanation: '', options: [], ...o });
const DEFS = [
  def({ id: 'T1', label: 'Referentie' }),
  def({ id: 'N1', label: 'Aantal', kind: 'number' }),
  def({ id: 'D1', label: 'Laatst beoordeeld', kind: 'date' }),
  def({ id: 'C1', label: 'Fase', kind: 'choice', options: ['Laag', 'Midden', 'Hoog'] }),
  def({ id: 'B1', label: 'Getoetst', kind: 'boolean' }),
];
const rule = (o) => ({
  id: 'R', kind: 'attribute_condition', label: 'Regel', explanation: '', enabled: true, subjectTypes: ['Capability'],
  targetTypes: [], weight: 'any', min: null, max: null, tagCategory: null, field: null, attributeId: 'T1', operator: 'is_empty', value: null, value2: null, ...o,
});
const el = (code, type = 'Capability') => ({ code, type, desc: '', kpi: '', taakveld: '', subtaakveld: '' });

// Eén element E1 met één waarde; geeft de overtredingstekst terug (of null).
function check(attributeId, operator, value, elementValue, value2 = null, defs = DEFS, today = TODAY) {
  const values = elementValue === undefined ? {} : { E1: { [attributeId]: elementValue } };
  const res = F.evaluateControlRules({ E1: el('E1') }, [], {}, {}, [rule({ attributeId, operator, value, value2 })], TYPE_TO_BASE, [], defs, values, today);
  return res.byElement.E1 ? res.byElement.E1[0].detail : null;
}
const ok = (...args) => assert.equal(check(...args), null, `zou moeten voldoen: ${JSON.stringify(args)}`);
const bad = (...args) => assert.ok(check(...args), `zou een overtreding moeten zijn: ${JSON.stringify(args)}`);

function assertNoInjectedMarkup(html) {
  assert.doesNotMatch(html, /<img|<script|<svg/i);
  for (const tag of html.match(/<[^>]+>/g) ?? []) {
    assert.doesNotMatch(tag.replace(/"[^"]*"/g, '""'), /\son[a-z]+\s*=/i, `inline handler in ${tag}`);
  }
}

describe('controleregels op kenmerken in tree.html (DOEL-77)', () => {
  it('tekst: bevat, bevat niet, is gelijk aan, begint met — niet hoofdlettergevoelig', () => {
    ok('T1', 'text_contains', 'ref', 'Dossier REF-12');
    bad('T1', 'text_contains', 'ref', 'Dossier 12');
    ok('T1', 'text_not_contains', 'concept', 'Definitief');
    bad('T1', 'text_not_contains', 'CONCEPT', 'concept v2');
    ok('T1', 'text_equals', 'Akkoord', 'akkoord');
    bad('T1', 'text_equals', 'Akkoord', 'Akkoord onder voorwaarden');
    ok('T1', 'text_starts_with', 'doc-', 'DOC-2026-01');
    bad('T1', 'text_starts_with', 'doc-', 'zie DOC-2026-01');
  });

  it('getal: gelijk, niet gelijk, kleiner, hooguit, groter, minstens, tussen (grenzen tellen mee)', () => {
    ok('N1', 'num_eq', 5, 5); bad('N1', 'num_eq', 5, 5.5);
    ok('N1', 'num_ne', 5, 4); bad('N1', 'num_ne', 5, 5);
    ok('N1', 'num_lt', 5, 4.999999); bad('N1', 'num_lt', 5, 5);
    ok('N1', 'num_lte', 5, 5); bad('N1', 'num_lte', 5, 5.000001);
    ok('N1', 'num_gt', 0, 0.000001); bad('N1', 'num_gt', 0, 0);
    ok('N1', 'num_gte', 0, 0); bad('N1', 'num_gte', 0, -1);
    ok('N1', 'num_between', 1, 1, 10); ok('N1', 'num_between', 1, 10, 10); ok('N1', 'num_between', 1, 5, 10);
    bad('N1', 'num_between', 1, 0.999999, 10); bad('N1', 'num_between', 1, 10.000001, 10);
  });

  it('datum: vóór, op of vóór, na, op of na een vaste datum', () => {
    ok('D1', 'date_before', '2026-07-01', '2026-06-30'); bad('D1', 'date_before', '2026-07-01', '2026-07-01');
    ok('D1', 'date_on_or_before', '2026-07-01', '2026-07-01'); bad('D1', 'date_on_or_before', '2026-07-01', '2026-07-02');
    ok('D1', 'date_after', '2026-07-01', '2026-07-02'); bad('D1', 'date_after', '2026-07-01', '2026-07-01');
    ok('D1', 'date_on_or_after', '2026-07-01', '2026-07-01'); bad('D1', 'date_on_or_after', '2026-07-01', '2026-06-30');
  });

  it('datum: hooguit/minstens N dagen oud — precies N dagen telt mee; hele dagen, ook over de zomertijdwissel heen', () => {
    // Vandaag is 2026-10-03. 2026-04-06 ligt 180 dagen terug; 2026-03-28 ligt
    // 189 dagen terug, vóór de zomertijdwissel van 29 maart 2026.
    assert.equal(F.attributeDayNumber(TODAY) - F.attributeDayNumber('2026-04-06'), 180);
    assert.equal(F.attributeDayNumber(TODAY) - F.attributeDayNumber('2026-03-28'), 189);
    ok('D1', 'date_max_days_old', 180, '2026-04-06');
    bad('D1', 'date_max_days_old', 180, '2026-04-05');
    ok('D1', 'date_max_days_old', 189, '2026-03-28');
    bad('D1', 'date_max_days_old', 188, '2026-03-28');
    ok('D1', 'date_max_days_old', 0, TODAY);
    bad('D1', 'date_max_days_old', 0, '2026-10-02');
    ok('D1', 'date_max_days_old', 0, '2026-12-01');
    ok('D1', 'date_min_days_old', 180, '2026-04-06');
    bad('D1', 'date_min_days_old', 180, '2026-04-07');
    ok('D1', 'date_min_days_old', 0, TODAY);
    bad('D1', 'date_min_days_old', 1, TODAY);
    bad('D1', 'date_min_days_old', 0, '2026-10-04');
  });

  it('datum: ligt niet in het verleden; hooguit N dagen in de toekomst', () => {
    ok('D1', 'date_not_in_past', null, TODAY);
    ok('D1', 'date_not_in_past', null, '2027-01-01');
    bad('D1', 'date_not_in_past', null, '2026-10-02');
    ok('D1', 'date_max_days_ahead', 30, '2026-11-02');
    bad('D1', 'date_max_days_ahead', 30, '2026-11-03');
    ok('D1', 'date_max_days_ahead', 30, '2020-01-01');
    ok('D1', 'date_max_days_ahead', 0, TODAY);
    bad('D1', 'date_max_days_ahead', 0, '2026-10-04');
  });

  it('datumregels zijn tijdsafhankelijk: dezelfde waarde voldoet vandaag en morgen niet meer', () => {
    assert.equal(check('D1', 'date_max_days_old', 180, '2026-04-06', null, DEFS, '2026-10-03'), null);
    assert.ok(check('D1', 'date_max_days_old', 180, '2026-04-06', null, DEFS, '2026-10-04'));
    // Zonder "vandaag"-parameter gebruikt de evaluatie de lokale datum van de browser.
    assert.match(F.localTodayIso(), /^\d{4}-\d{2}-\d{2}$/);
    const res = F.evaluateControlRules({ E1: el('E1') }, [], {}, {}, [rule({ attributeId: 'D1', operator: 'date_not_in_past' })], TYPE_TO_BASE, [], DEFS, { E1: { D1: '1999-01-01' } });
    assert.ok(res.byElement.E1);
  });

  it('keuzelijst: is een van, is geen van; ja/nee: is ja, is nee (nee is een ingevulde waarde)', () => {
    ok('C1', 'choice_one_of', ['Midden', 'Hoog'], 'Hoog'); bad('C1', 'choice_one_of', ['Midden', 'Hoog'], 'Laag');
    ok('C1', 'choice_none_of', ['Laag'], 'Hoog'); bad('C1', 'choice_none_of', ['Laag'], 'Laag');
    ok('B1', 'bool_true', null, true); bad('B1', 'bool_true', null, false);
    ok('B1', 'bool_false', null, false); bad('B1', 'bool_false', null, true);
  });

  it('een vergelijkingsregel toetst alleen ingevulde waarden; "is leeg" is overtreden door een ingevulde waarde', () => {
    for (const [id, op, v, v2] of [
      ['T1', 'text_contains', 'x'], ['T1', 'text_not_contains', 'x'], ['N1', 'num_gt', 0], ['N1', 'num_between', 1, 2],
      ['D1', 'date_max_days_old', 1], ['D1', 'date_not_in_past', null], ['C1', 'choice_one_of', ['Laag']], ['B1', 'bool_true', null],
    ]) {
      for (const empty of [undefined, null, '']) ok(id, op, v, empty, v2 ?? null);
    }
    ok('T1', 'is_empty', null, undefined);
    bad('T1', 'is_empty', null, 'iets');
    bad('N1', 'is_empty', null, 0);
    bad('B1', 'is_empty', null, false);
    assert.equal(check('B1', 'is_empty', null, false), '"Getoetst" is Nee; eis: is leeg');
  });

  it('de overtredingstekst noemt het kenmerk, de waarde en de eis in leesbare vorm', () => {
    assert.equal(check('D1', 'date_max_days_old', 180, '2026-01-15'), '"Laatst beoordeeld" is 15-01-2026; eis: is hooguit 180 dagen oud');
    assert.equal(check('D1', 'date_min_days_old', 1, TODAY), '"Laatst beoordeeld" is 03-10-2026; eis: is minstens 1 dag oud');
    assert.equal(check('D1', 'date_before', '2026-07-01', '2026-07-01'), '"Laatst beoordeeld" is 01-07-2026; eis: ligt vóór 01-07-2026');
    assert.equal(check('N1', 'num_between', 1.5, 12.5, 10), '"Aantal" is 12,5; eis: ligt tussen 1,5 en 10');
    assert.equal(check('C1', 'choice_one_of', ['Midden', 'Hoog'], 'Laag'), '"Fase" is Laag; eis: is een van: Midden, Hoog');
    assert.equal(check('T1', 'text_starts_with', 'DOC-', 'x'), '"Referentie" is x; eis: begint met "DOC-"');
    const all = {
      text_contains: ['bevat "x"', 'x'], text_not_contains: ['bevat niet "x"', 'x'], text_equals: ['is gelijk aan "x"', 'x'],
      num_eq: ['is gelijk aan 2', 2], num_ne: ['is niet gelijk aan 2', 2], num_lt: ['is kleiner dan 2', 2], num_lte: ['is hooguit 2', 2],
      num_gt: ['is groter dan 2', 2], num_gte: ['is minstens 2', 2],
      date_on_or_before: ['ligt op of vóór 31-12-2026', '2026-12-31'], date_after: ['ligt na 31-12-2026', '2026-12-31'],
      date_on_or_after: ['ligt op of na 31-12-2026', '2026-12-31'], date_not_in_past: ['ligt niet in het verleden', null],
      date_max_days_ahead: ['ligt hooguit 30 dagen in de toekomst', 30], choice_none_of: ['is geen van: Laag', ['Laag']],
      bool_true: ['is ja', null], bool_false: ['is nee', null], is_empty: ['is leeg', null],
    };
    for (const [operator, [text, value]] of Object.entries(all)) assert.equal(F.attributeRequirementText({ operator, value }), text, operator);
    assert.equal(F.attributeRequirementText({ operator: 'onbekend', value: 1 }), '');
  });

  it('onbekende eis, verdwenen kenmerk of een waarde van de verkeerde soort geeft geen (valse) overtreding en geen fout', () => {
    ok('T1', 'bestaat_niet', 'x', 'iets');
    ok('ONBEKEND', 'text_contains', 'x', 'iets');
    ok('N1', 'num_gt', 5, 'tekst');
    ok('D1', 'date_max_days_old', 5, 'geen datum');
    ok('D1', 'date_before', 'geen datum', '2026-01-01');
    assert.equal(check('D1', 'date_max_days_old', 5, '2020-01-01', null, DEFS, 'geen datum'), null);
  });

  it('verplicht kenmerk: ingebouwde regel req-<id> "Verplicht: <label>", alleen voor typen waarvoor het geldt (alias volgt basistype)', () => {
    const defs = [def({ id: 'D1', label: 'Laatst beoordeeld', kind: 'date', required: true }), def({ id: 'B1', label: 'Getoetst', kind: 'boolean', required: true }), def({ id: 'T1' })];
    const details = { C1: el('C1'), C2: el('C2'), V1: el('V1', 'Variant'), P1: el('P1', 'Project') };
    const values = { C1: { D1: '2026-01-01', B1: false }, C2: { B1: true } };
    const res = F.evaluateControlRules(details, [], {}, {}, [], TYPE_TO_BASE, [], defs, values, TODAY);
    assert.deepEqual(res.activeRules.map((r) => [r.id, r.label]), [['req-D1', 'Verplicht: Laatst beoordeeld'], ['req-B1', 'Verplicht: Getoetst']]);
    assert.equal(res.byElement.C1, undefined, 'alles ingevuld (nee is een waarde)');
    assert.deepEqual(res.byElement.C2.map((v) => [v.ruleId, v.detail]), [['req-D1', 'Verplicht kenmerk "Laatst beoordeeld" is niet ingevuld']]);
    assert.deepEqual(res.byElement.V1.map((v) => v.ruleId), ['req-D1', 'req-B1'], 'alias-element');
    assert.equal(res.byElement.P1, undefined, 'kenmerk geldt niet voor Project');
    assert.deepEqual(res.countsByRule, { 'req-D1': 2, 'req-B1': 1 });
    assert.equal(res.openElements, 2);
    // Zonder kenmerken (oude aanroep, of module zonder kenmerken) verandert er niets.
    const none = F.evaluateControlRules(details, [], {}, {}, [], TYPE_TO_BASE, []);
    assert.deepEqual([none.activeRules, none.byElement], [[], {}]);
  });

  it('geen dubbel signaal: leeg + verplicht + vergelijkingsregel geeft alleen de verplicht-overtreding', () => {
    const defs = [def({ id: 'D1', label: 'Laatst beoordeeld', kind: 'date', required: true })];
    const rules = [rule({ id: 'R1', attributeId: 'D1', operator: 'date_max_days_old', value: 180 })];
    const res = F.evaluateControlRules({ C1: el('C1'), C2: el('C2') }, [], {}, {}, rules, TYPE_TO_BASE, [], defs, { C2: { D1: '2020-01-01' } }, TODAY);
    assert.deepEqual(res.byElement.C1.map((v) => v.ruleId), ['req-D1']);
    assert.deepEqual(res.byElement.C2.map((v) => v.ruleId), ['R1']);
    assert.deepEqual(res.activeRules.map((r) => r.id), ['R1', 'req-D1'], 'eigen regels eerst, ingebouwde erna');
  });

  it('een uitgeschakelde kenmerkregel telt niet; een kenmerkregel geldt alleen voor zijn elementtypen (alias volgt basistype)', () => {
    const details = { C1: el('C1'), V1: el('V1', 'Variant'), P1: el('P1', 'Project') };
    const values = { C1: { T1: 'x' }, V1: { T1: 'x' }, P1: { T1: 'x' } };
    const on = F.evaluateControlRules(details, [], {}, {}, [rule({})], TYPE_TO_BASE, [], DEFS, values, TODAY);
    assert.deepEqual(Object.keys(on.byElement).sort(), ['C1', 'V1']);
    const off = F.evaluateControlRules(details, [], {}, {}, [rule({ enabled: false })], TYPE_TO_BASE, [], DEFS, values, TODAY);
    assert.deepEqual(off.byElement, {});
  });

  it('motiveren werkt ongewijzigd, ook op de ingebouwde regel: open/gemotiveerd apart geteld, grijs in hint en paneel', () => {
    const defs = [def({ id: 'D1', label: 'Laatst beoordeeld', kind: 'date', required: true })];
    const rules = [rule({ id: 'R1', attributeId: 'D1', operator: 'date_max_days_old', value: 180 })];
    const deviations = [
      { elementCode: 'C1', ruleId: 'req-D1', motivatie: 'Nog niet beoordeeld, gepland', updatedAt: '2026-10-01T08:00:00Z' },
      { elementCode: 'C2', ruleId: 'R1', motivatie: 'Uitstel akkoord', updatedAt: '2026-10-01T08:00:00Z' },
    ];
    const res = F.evaluateControlRules({ C1: el('C1'), C2: el('C2'), C3: el('C3') }, [], {}, {}, rules, TYPE_TO_BASE, deviations, defs, { C2: { D1: '2020-01-01' } }, TODAY);
    assert.deepEqual([res.openElements, res.motivatedOnlyElements], [1, 2]);
    assert.deepEqual(res.countsByRule, { R1: 0, 'req-D1': 1 });
    assert.deepEqual(res.motivatedByRule, { R1: 1, 'req-D1': 1 });
    assert.equal(res.byElement.C1[0].deviation.motivatie, 'Nog niet beoordeeld, gepland');
    assert.match(F.controlRuleHintHtml(res.byElement.C1), /tt-rules-motivated/);
    const panel = F.controlRuleViolationsHtml(res.byElement.C3, { canEdit: true, elementCode: 'C3' });
    assert.match(panel, /data-dev-action="edit" data-code="C3" data-rule-id="req-D1">Motiveer afwijking/);
    const summary = F.controlRulesSummaryHtml(res, false);
    assert.match(summary, /data-rule-id="req-D1"[^>]*><div class="cs-stat-value">1<\/div>.*Verplicht: Laatst beoordeeld/);
  });

  it('A03: kenmerklabels, waarden en regelwaarden zijn ge-escaped in hint, detailpaneel en samenvatting', () => {
    const XSS = '<img src=x onerror=alert(1)><script>alert(2)</script>"\'>';
    const defs = [
      def({ id: 'X1', label: XSS, required: true, explanation: XSS }),
      def({ id: 'X2', label: `Keuze ${XSS}`, kind: 'choice', options: [XSS, 'Gewoon'] }),
    ];
    const rules = [
      rule({ id: 'R1', attributeId: 'X1', operator: 'text_contains', value: XSS, label: XSS, explanation: XSS }),
      rule({ id: 'R2', attributeId: 'X2', operator: 'choice_none_of', value: [XSS] }),
    ];
    const values = { C1: { X1: 'anders', X2: XSS }, C2: {} };
    const res = F.evaluateControlRules({ C1: el('C1'), C2: el('C2') }, [], {}, {}, rules, TYPE_TO_BASE, [], defs, values, TODAY);
    assert.deepEqual(res.byElement.C1.map((v) => v.ruleId), ['R1', 'R2']);
    assert.deepEqual(res.byElement.C2.map((v) => v.ruleId), ['req-X1']);
    assert.ok(res.byElement.C1[1].detail.includes(XSS), 'de ruwe tekst zit in het resultaat; escapen gebeurt bij het renderen');
    const outputs = [
      F.controlRuleHintHtml(res.byElement.C1), F.controlRuleHintHtml(res.byElement.C2),
      F.controlRuleViolationsHtml(res.byElement.C1, { canEdit: true, elementCode: 'C1' }),
      F.controlRuleViolationsHtml(res.byElement.C2, { canEdit: true, elementCode: 'C2', editingRuleId: 'req-X1' }),
      F.controlRulesSummaryHtml(res, true),
    ];
    for (const html of outputs) {
      assertNoInjectedMarkup(html);
      assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'payload staat er als tekst');
    }
  });

  it('A03/CSP: de nieuwe functies bevatten geen eval, geen inline handlers en bouwen zelf geen HTML', () => {
    const code = ['attributeRequirementText', 'attributeConditionHolds', 'attributeConditionViolation', 'attributeDayNumber', 'localTodayIso'].map(grab).join('\n');
    assert.doesNotMatch(code, /\beval\s*\(|new Function\s*\(|javascript:|innerHTML/);
    assert.doesNotMatch(code, /<[a-z]+[\s>]/i, 'geen HTML in de evaluatiefuncties');
  });

  it('de boom geeft de kenmerken en waarden door aan de evaluatie', () => {
    assert.match(source, /CONTROL_EVAL = evaluateControlRules\(DETAILS, EDGES, ELEMENT_TAGS, TAGS, CONTROL_RULES, TYPE_TO_BASE, CONTROL_DEVIATIONS, ATTRIBUTES, ATTRIBUTE_VALUES\);/);
  });

  it('prestatie: 500 elementen, 30 kenmerken (waarvan 10 verplicht) en 50 regels ruim onder 50 ms', () => {
    const defs = Array.from({ length: 30 }, (_, i) => def({
      id: `K${i}`, label: `Kenmerk ${i}`, kind: ['text', 'number', 'date', 'choice', 'boolean'][i % 5], required: i < 10,
      subjectTypes: ['Capability', 'Project'], options: i % 5 === 3 ? ['Laag', 'Midden', 'Hoog'] : [],
    }));
    const opFor = { text: ['text_contains', 'a'], number: ['num_gte', 10], date: ['date_max_days_old', 180], choice: ['choice_one_of', ['Hoog']], boolean: ['bool_true', null] };
    const rules = Array.from({ length: 50 }, (_, i) => {
      const d = defs[i % 30];
      return rule({ id: `R${i}`, attributeId: d.id, operator: opFor[d.kind][0], value: opFor[d.kind][1], subjectTypes: ['Capability', 'Project'] });
    });
    const details = {}; const values = {}; const edges = [];
    for (let i = 0; i < 500; i += 1) {
      const code = `E${i}`;
      details[code] = el(code, i % 3 === 0 ? 'Project' : (i % 3 === 1 ? 'Capability' : 'Variant'));
      values[code] = {};
      defs.forEach((d, k) => {
        if ((i + k) % 4 === 0) return; // een kwart leeg
        values[code][d.id] = { text: `waarde ${i}`, number: i % 20, date: i % 2 ? '2026-09-01' : '2025-01-01', choice: ['Laag', 'Midden', 'Hoog'][i % 3], boolean: i % 2 === 0 }[d.kind];
      });
      if (i > 0) edges.push({ source: code, target: `E${i - 1}`, weight: 'primair' });
    }
    const run = () => F.evaluateControlRules(details, edges, {}, {}, rules, TYPE_TO_BASE, [], defs, values, TODAY);
    run(); // opwarmen
    const times = [];
    let res;
    for (let i = 0; i < 15; i += 1) { const t0 = performance.now(); res = run(); times.push(performance.now() - t0); }
    times.sort((a, b) => a - b);
    const median = times[7];
    console.log(`PRESTATIE evaluatie 500 elementen x (50 regels + 10 verplicht): mediaan ${median.toFixed(2)} ms, max ${times[14].toFixed(2)} ms, ${Object.keys(res.byElement).length} elementen met een overtreding`);
    assert.ok(Object.keys(res.byElement).length > 100, 'de test evalueert echt iets');
    assert.ok(median < 50, `mediaan ${median.toFixed(2)} ms`);
  });
});

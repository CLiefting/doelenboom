// Regressietests voor DOEL-63 (epic DOEL-61): evaluatie en weergave van
// controleregels in web/public/tree.html. Zelfde aanpak als
// tree-html-alias.test.mjs: de ECHTE functies uit het uitgeleverde bestand
// halen en los uitvoeren, zodat precies dezelfde code getest wordt als in de
// browser draait.
//
// Uitvoeren: node --test web/test/tree-html-control-rules.test.mjs

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

function load() {
  // eslint-disable-next-line no-new-func
  return new Function(
    [
      grab('escapeHtml'), grabConst('CONTROL_RULE_FIELD_LABELS'), grabConst('CONTROL_RULE_FIELD_KEYS'),
      grab('controlRuleTypeList'), grab('evaluateControlRules'), grab('controlRuleTooltipText'),
      grab('controlRuleViolationsHtml'), grab('controlRulesSummaryHtml'),
    ].join('\n') +
      '\nreturn { evaluateControlRules, controlRuleTooltipText, controlRuleViolationsHtml, controlRulesSummaryHtml };'
  )();
}
const F = load();

// Kleine boom: kolommen Project(+alias "Project 1") -> Capability -> Doel -> Missie.
const TYPE_TO_BASE = { Project: 'Project', 'Project 1': 'Project', Capability: 'Capability', Doel: 'Doel', Missie: 'Missie' };
function tree() {
  const details = {
    P1: { code: 'P1', type: 'Project', desc: 'x', kpi: '', taakveld: '', subtaakveld: '' },
    PA: { code: 'PA', type: 'Project 1', desc: '', kpi: 'k', taakveld: '', subtaakveld: '' },
    C1: { code: 'C1', type: 'Capability', desc: '', kpi: '', taakveld: '', subtaakveld: '' },
    C2: { code: 'C2', type: 'Capability', desc: '  ', kpi: '', taakveld: '', subtaakveld: '' },
    D1: { code: 'D1', type: 'Doel', desc: '', kpi: '', taakveld: '', subtaakveld: '' },
    D2: { code: 'D2', type: 'Doel', desc: '', kpi: '', taakveld: '', subtaakveld: '' },
    M1: { code: 'M1', type: 'Missie', desc: '', kpi: '', taakveld: '', subtaakveld: '' },
  };
  const edges = [
    { source: 'P1', target: 'C1', weight: 'primair' },
    { source: 'PA', target: 'C1', weight: 'ondersteunend' },
    { source: 'C1', target: 'D1', weight: 'primair' },
    { source: 'C1', target: 'D2', weight: 'primair' },
    { source: 'D1', target: 'M1' },
    // C2 en D2 hangen nergens aan (D2 heeft geen ouder, C2 geen ouder).
  ];
  const tags = { T1: { categorie: 'Thema' }, T2: { categorie: 'Overig' } };
  const elementTags = { P1: ['T1'], PA: ['T2'] };
  return { details, edges, tags, elementTags };
}
const rule = (o) => ({ id: 'R', label: 'Regel', explanation: '', enabled: true, subjectTypes: [], targetTypes: [], weight: 'any', min: 1, max: null, tagCategory: null, field: null, ...o });
function run(rules) {
  const t = tree();
  return F.evaluateControlRules(t.details, t.edges, t.elementTags, t.tags, rules, TYPE_TO_BASE);
}
const violators = (res, id = 'R') => Object.keys(res.byElement).filter((c) => res.byElement[c].some((v) => v.ruleId === id)).sort();

describe('evaluateControlRules (DOEL-63)', () => {
  it('requires_outgoing: "heeft een ouder van type" — voldoet en overtreedt', () => {
    const res = run([rule({ kind: 'requires_outgoing', subjectTypes: ['Doel'], targetTypes: ['Missie'] })]);
    assert.deepEqual(violators(res), ['D2']);
    assert.equal(res.countsByRule.R, 1);
    assert.match(res.byElement.D2[0].detail, /^0 ouders van type Missie, minimaal 1 vereist$/);
  });

  it('requires_incoming: "heeft een kind van type"', () => {
    const res = run([rule({ kind: 'requires_incoming', subjectTypes: ['Capability'], targetTypes: ['Project'] })]);
    // C1 heeft kinderen P1 (Project) en PA (alias Project 1); C2 heeft er geen.
    assert.deepEqual(violators(res), ['C2']);
    assert.match(res.byElement.C2[0].detail, /0 kinderen van type Project/);
  });

  it('weight=primair telt alleen primaire relaties', () => {
    const any = run([rule({ kind: 'requires_outgoing', subjectTypes: ['Project'], targetTypes: ['Capability'] })]);
    assert.deepEqual(violators(any), []);
    const prim = run([rule({ kind: 'requires_outgoing', subjectTypes: ['Project'], targetTypes: ['Capability'], weight: 'primair' })]);
    // PA (alias van Project) hangt alleen ondersteunend aan C1.
    assert.deepEqual(violators(prim), ['PA']);
    assert.match(prim.byElement.PA[0].detail, /primaire ouders van type Capability/);
  });

  it('max: te veel relaties is ook een overtreding', () => {
    const res = run([rule({ kind: 'requires_outgoing', subjectTypes: ['Capability'], targetTypes: ['Doel'], min: 0, max: 1 })]);
    assert.deepEqual(violators(res), ['C1']);
    assert.match(res.byElement.C1[0].detail, /^2 ouders van type Doel, maximaal 1 toegestaan$/);
  });

  it('primary_parent_count: precies 1 primaire ouder', () => {
    const res = run([rule({ kind: 'primary_parent_count', subjectTypes: ['Capability', 'Doel'], min: 1, max: 1 })]);
    // C1: 2 primair (te veel); C2: 0; D1: alleen niet-primair naar M1; D2: 0.
    assert.deepEqual(violators(res), ['C1', 'C2', 'D1', 'D2']);
  });

  it('requires_tag_category', () => {
    const res = run([rule({ kind: 'requires_tag_category', subjectTypes: ['Project'], tagCategory: 'Thema' })]);
    assert.deepEqual(violators(res), ['PA']);
    assert.match(res.byElement.PA[0].detail, /0 tags in categorie "Thema"/);
  });

  it('required_field: leeg of alleen spaties telt als leeg', () => {
    const res = run([rule({ kind: 'required_field', subjectTypes: ['Project', 'Capability'], field: 'description', min: null })]);
    assert.deepEqual(violators(res), ['C1', 'C2', 'PA']);
    assert.match(res.byElement.C2[0].detail, /Veld "Omschrijving" is leeg/);
  });

  it('enabled=false wordt overgeslagen (ook niet in de telling)', () => {
    const res = run([rule({ kind: 'requires_outgoing', subjectTypes: ['Doel'], targetTypes: ['Missie'], enabled: false })]);
    assert.deepEqual(res.byElement, {});
    assert.deepEqual(res.activeRules, []);
    assert.equal(res.countsByRule.R, undefined);
  });

  it('aliassen: regel op het basistype geldt ook voor de alias; regel op de alias alleen voor de alias', () => {
    const base = run([rule({ kind: 'required_field', subjectTypes: ['Project'], field: 'kpi', min: null })]);
    assert.deepEqual(violators(base), ['P1'], 'P1 (Project) en PA (alias) vallen onder de regel; alleen P1 heeft geen KPI');
    const alias = run([rule({ kind: 'required_field', subjectTypes: ['Project 1'], field: 'description', min: null })]);
    assert.deepEqual(violators(alias), ['PA'], 'P1 valt niet onder een regel die alleen de alias noemt');
    // Doeltype: kind van alias-type telt als kind van het basistype.
    const tgt = run([rule({ kind: 'requires_incoming', subjectTypes: ['Capability'], targetTypes: ['Project'], min: 2 })]);
    assert.deepEqual(violators(tgt), ['C2'], 'C1 heeft P1 + PA (alias) = 2 kinderen van type Project');
  });

  it('meerdere regels: overtredingen per element gestapeld, telling per regel', () => {
    const res = run([
      rule({ id: 'A', kind: 'requires_outgoing', subjectTypes: ['Doel'], targetTypes: ['Missie'] }),
      rule({ id: 'B', kind: 'required_field', subjectTypes: ['Doel'], field: 'kpi', min: null }),
    ]);
    assert.equal(res.byElement.D2.length, 2);
    assert.equal(res.countsByRule.A, 1);
    assert.equal(res.countsByRule.B, 2);
  });

  it('onafhankelijk van wat zichtbaar is: de functie kent geen DOM, alleen de volledige dataset', () => {
    const fn = grab('evaluateControlRules');
    assert.doesNotMatch(fn, /document\.|querySelector|hidden|classList/);
  });

  it('prestatie: boom ter grootte van FPBB (± 150 elementen, ± 300 relaties) ruim binnen 50 ms', () => {
    const types = ['Project', 'Capability', 'Doel', 'Missie'];
    const details = {};
    for (let i = 0; i < 150; i++) details['E' + i] = { code: 'E' + i, type: types[i % 4], desc: '', kpi: '', taakveld: '', subtaakveld: '' };
    const edges = [];
    for (let i = 0; i < 300; i++) edges.push({ source: 'E' + (i % 150), target: 'E' + ((i * 7 + 1) % 150), weight: i % 2 ? 'primair' : undefined });
    const rules = [
      rule({ id: 'a', kind: 'requires_outgoing', subjectTypes: ['Project'], targetTypes: ['Capability'] }),
      rule({ id: 'b', kind: 'requires_incoming', subjectTypes: ['Capability'], targetTypes: ['Project'] }),
      rule({ id: 'c', kind: 'primary_parent_count', subjectTypes: ['Doel'], min: 1, max: 1 }),
      rule({ id: 'd', kind: 'required_field', subjectTypes: types, field: 'kpi', min: null }),
      rule({ id: 'e', kind: 'requires_tag_category', subjectTypes: types, tagCategory: 'X' }),
    ];
    F.evaluateControlRules(details, edges, {}, {}, rules, TYPE_TO_BASE); // warm-up
    const t0 = performance.now();
    for (let k = 0; k < 20; k++) F.evaluateControlRules(details, edges, {}, {}, rules, TYPE_TO_BASE);
    const ms = (performance.now() - t0) / 20;
    console.log(`  evaluateControlRules, 150 elementen / 300 relaties / 5 regels: ${ms.toFixed(3)} ms per evaluatie`);
    assert.ok(ms < 50, `${ms} ms`);
  });
});

describe('weergave controleregels: XSS (OWASP A03, DOEL-63)', () => {
  const payloads = ['<img src=x onerror=alert(1)>', '"><script>alert(2)</script>', "' onmouseover='alert(3)"];
  const evilViolations = payloads.map((p, i) => ({ ruleId: 'R' + i, label: p, explanation: p, detail: p }));
  // Echte eis: payload mag als (ge-escapete) tekst voorkomen, maar nooit als tag of attribuut.
  const assertNoInjectedMarkup = (html) => {
    const tags = html.match(/<[^>]*>/g) || [];
    for (const t of tags) {
      assert.doesNotMatch(t, /^<\/?(img|script|b)\b/i, `geïnjecteerde tag: ${t}`);
      assert.doesNotMatch(t, /\son[a-z]+\s*=/i, `geïnjecteerde handler: ${t}`);
    }
  };

  it('detailpaneel: label/uitleg/detail ge-escaped', () => {
    const html = F.controlRuleViolationsHtml(evilViolations);
    assertNoInjectedMarkup(html);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /&quot;&gt;&lt;script&gt;/);
  });

  it('samenvattingspaneel: label en regel-id ge-escaped, ook in data-rule-id', () => {
    const evalRes = {
      activeRules: payloads.map((p, i) => ({ id: 'X"' + i + '><b', label: p })),
      countsByRule: {}, byElement: {},
    };
    const html = F.controlRulesSummaryHtml(evalRes);
    assertNoInjectedMarkup(html);
    assert.match(html, /data-rule-id="X&quot;0&gt;&lt;b"/);
  });

  it('tooltip is platte tekst (gezet via de .title-eigenschap, niet als HTML)', () => {
    const txt = F.controlRuleTooltipText(evilViolations);
    assert.match(txt, /<img src=x onerror=alert\(1\)>/, 'platte tekst, ongewijzigd');
    // En de aanroeper zet het via .title (DOM-eigenschap), niet via innerHTML/setAttribute-HTML.
    assert.match(source, /icon\.title = controlRuleTooltipText\(v\);/);
  });

  it('SVG-export: alleen een symbool, nooit regeltekst; geen innerHTML in de rule-icon-code', () => {
    const block = extract(/const ruleIcon = node\.querySelector\('\.node-rule-icon'\);[\s\S]*?content\.appendChild\(g\);/, 'SVG rule-icon-blok');
    assert.doesNotMatch(block, /innerHTML|label|explanation|detail|title/);
    assert.match(block, /bang\.textContent = '!'/);
  });

  it('geen inline event-handlers of javascript:-URL\'s in de nieuwe code (CSP)', () => {
    const fns = ['controlRuleViolationsHtml', 'controlRulesSummaryHtml', 'controlRuleTooltipText'].map(grab).join('\n');
    assert.doesNotMatch(fns, /\son[a-z]+=|javascript:/i);
    const view = extract(/\/\/ ---- Controleweergave \(DOEL-63\) ----[\s\S]*?\n  if \(controlRulesBtn\) \{/, 'controleweergave-blok');
    assert.doesNotMatch(view, /setAttribute\('on|\.on[a-z]+ = /);
  });
});

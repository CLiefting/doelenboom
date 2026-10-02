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

const grabLine = (name) => extract(new RegExp(`const ${name} = [^\\n]*;`), name);

function load() {
  // eslint-disable-next-line no-new-func
  return new Function(
    [
      grab('escapeHtml'), grabConst('CONTROL_RULE_FIELD_LABELS'), grabConst('CONTROL_RULE_FIELD_KEYS'),
      grabLine('CONTROL_DEVIATION_MAX_LENGTH'), grabLine('CONTROL_DEVIATION_HINT'),
      grab('controlRuleTypeList'), grab('controlDeviationKey'), grab('evaluateControlRules'),
      grab('controlViolationsAllMotivated'), grab('controlDeviationMetaText'),
      grab('controlRuleTooltipText'), grab('controlRuleHintHtml'),
      grab('controlRuleDeviationFormHtml'), grab('controlRuleViolationsHtml'), grab('controlRulesSummaryHtml'),
    ].join('\n') +
      '\nreturn { evaluateControlRules, controlRuleTooltipText, controlRuleHintHtml, controlRuleViolationsHtml, ' +
      'controlRulesSummaryHtml, controlRuleDeviationFormHtml, controlViolationsAllMotivated, controlDeviationMetaText, ' +
      'CONTROL_DEVIATION_MAX_LENGTH, CONTROL_DEVIATION_HINT };'
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

  it('aria-label van het icoon is platte tekst (setAttribute, niet als HTML)', () => {
    const txt = F.controlRuleTooltipText(evilViolations);
    assert.match(txt, /<img src=x onerror=alert\(1\)>/, 'platte tekst, ongewijzigd');
    assert.match(source, /icon\.setAttribute\('aria-label', controlRuleTooltipText\(v\)\);/);
  });

  it('hover-kaartje (DOEL-68): id/label/detail ge-escaped; leeg zonder overtredingen', () => {
    const html = F.controlRuleHintHtml(evilViolations);
    assertNoInjectedMarkup(html);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /<span class="tt-rule-id">R0<\/span>/);
    assert.equal(F.controlRuleHintHtml([]), '');
    assert.equal(F.controlRuleHintHtml(undefined), '');
    const evilId = F.controlRuleHintHtml([{ ruleId: '<script>x</script>', label: 'l', detail: 'd' }]);
    assertNoInjectedMarkup(evilId);
    assert.match(evilId, /&lt;script&gt;x/);
  });

  it('hover-kaartje toont de reden alleen bij actieve controleweergave', () => {
    assert.match(source, /\(controlViewOn \? controlRuleHintHtml\(CONTROL_EVAL\.byElement\[node\.dataset\.id\]\) : ''\)/);
  });

  it('SVG-export: alleen een symbool, nooit regeltekst; geen innerHTML in de rule-icon-code', () => {
    const block = extract(/const ruleIcon = node\.querySelector\('\.node-rule-icon'\);[\s\S]*?content\.appendChild\(g\);/, 'SVG rule-icon-blok');
    assert.doesNotMatch(block, /innerHTML|label|explanation|detail|title/);
    assert.match(block, /bang\.textContent = '!'/);
  });

  it('geen inline event-handlers of javascript:-URL\'s in de nieuwe code (CSP)', () => {
    const fns = ['controlRuleViolationsHtml', 'controlRulesSummaryHtml', 'controlRuleTooltipText', 'controlRuleHintHtml'].map(grab).join('\n');
    assert.doesNotMatch(fns, /\son[a-z]+=|javascript:/i);
    const view = extract(/\/\/ ---- Controleweergave \(DOEL-63\) ----[\s\S]*?\n  if \(controlRulesBtn\) \{/, 'controleweergave-blok');
    assert.doesNotMatch(view, /setAttribute\('on|\.on[a-z]+ = /);
  });
});

// ---------------------------------------------------------------------------
// DOEL-64: gemotiveerde afwijking per (element, regel)
// ---------------------------------------------------------------------------

describe('gemotiveerde afwijkingen in de evaluatie (DOEL-64)', () => {
  const rules = [
    rule({ id: 'RA', kind: 'requires_outgoing', subjectTypes: ['Doel'], targetTypes: ['Missie'], label: 'Doel heeft missie' }),
    rule({ id: 'RB', kind: 'required_field', subjectTypes: ['Doel'], field: 'kpi', min: null, label: 'Doel heeft KPI' }),
  ];
  const run = (deviations) => {
    const t = tree();
    return F.evaluateControlRules(t.details, t.edges, t.elementTags, t.tags, rules, TYPE_TO_BASE, deviations);
  };

  it('zonder afwijkingen: alles open (gedrag van DOEL-63 ongewijzigd)', () => {
    const ev = run(undefined);
    assert.deepEqual(ev.countsByRule, { RA: 1, RB: 2 });
    assert.deepEqual(ev.motivatedByRule, { RA: 0, RB: 0 });
    assert.equal(ev.openElements, 2);
    assert.equal(ev.motivatedOnlyElements, 0);
    assert.ok(ev.byElement.D2.every((v) => v.deviation === null));
  });

  it('motiveren van één regel verbergt de andere overtreding van hetzelfde element niet', () => {
    const ev = run([{ elementCode: 'D2', ruleId: 'RA', motivatie: 'Bewust zo', updatedAt: '2026-10-02T08:00:00Z' }]);
    assert.deepEqual(ev.countsByRule, { RA: 0, RB: 2 });
    assert.deepEqual(ev.motivatedByRule, { RA: 1, RB: 0 });
    const d2 = Object.fromEntries(ev.byElement.D2.map((v) => [v.ruleId, v]));
    assert.equal(d2.RA.deviation.motivatie, 'Bewust zo');
    assert.equal(d2.RB.deviation, null);
    assert.equal(F.controlViolationsAllMotivated(ev.byElement.D2), false, 'nog 1 open -> oranje');
    assert.equal(ev.openElements, 2);
    assert.equal(ev.motivatedOnlyElements, 0);
  });

  it('uitsluitend gemotiveerde afwijkingen: element telt als gemotiveerd (grijs), niet als open', () => {
    const ev = run([
      { elementCode: 'D2', ruleId: 'RA', motivatie: 'a' },
      { elementCode: 'D2', ruleId: 'RB', motivatie: 'b' },
    ]);
    assert.equal(F.controlViolationsAllMotivated(ev.byElement.D2), true);
    assert.equal(F.controlViolationsAllMotivated(ev.byElement.D1), false);
    assert.equal(ev.openElements, 1);
    assert.equal(ev.motivatedOnlyElements, 1);
    assert.deepEqual(ev.countsByRule, { RA: 0, RB: 1 });
    assert.deepEqual(ev.motivatedByRule, { RA: 1, RB: 1 });
  });

  it('afwijking zonder (nog) bestaande overtreding of voor een onbekende regel/element wordt genegeerd', () => {
    const ev = run([
      { elementCode: 'D1', ruleId: 'RA', motivatie: 'D1 voldoet aan RA' },
      { elementCode: 'D2', ruleId: 'WEG', motivatie: 'regel bestaat niet' },
      { elementCode: 'ZZ', ruleId: 'RA', motivatie: 'element bestaat niet' },
      null,
    ]);
    assert.deepEqual(ev.countsByRule, { RA: 1, RB: 2 });
    assert.deepEqual(ev.motivatedByRule, { RA: 0, RB: 0 });
    assert.equal(ev.byElement.ZZ, undefined);
  });

  it('sleutel (element, regel) botst niet bij codes/ids die samen dezelfde tekst vormen', () => {
    const details = { 'A-B': { code: 'A-B', type: 'Doel', kpi: '' }, A: { code: 'A', type: 'Doel', kpi: '' } };
    const rs = [
      rule({ id: 'C', kind: 'required_field', subjectTypes: ['Doel'], field: 'kpi', min: null }),
      rule({ id: 'B-C', kind: 'required_field', subjectTypes: ['Doel'], field: 'kpi', min: null }),
    ];
    const ev = F.evaluateControlRules(details, [], {}, {}, rs, TYPE_TO_BASE, [{ elementCode: 'A-B', ruleId: 'C', motivatie: 'm' }]);
    assert.ok(ev.byElement['A-B'].find((v) => v.ruleId === 'C').deviation);
    assert.equal(ev.byElement.A.find((v) => v.ruleId === 'B-C').deviation, null);
  });

  it('tooltiptekst en door-wie/wanneer', () => {
    const ev = run([{ elementCode: 'D2', ruleId: 'RA', motivatie: 'm', updatedAt: '2026-10-02T08:00:00Z', updatedByEmail: 'a@b.nl' }]);
    assert.match(F.controlRuleTooltipText(ev.byElement.D2), /Doel heeft missie — .*\(gemotiveerd afgeweken\)/);
    assert.match(F.controlDeviationMetaText(ev.byElement.D2[0].deviation), /^Door a@b\.nl op 02-10-2026$/);
    assert.match(F.controlDeviationMetaText({ updatedAt: '2026-10-02T08:00:00Z' }), /^Op 02-10-2026$/, 'bezoeker: zonder e-mailadres');
    assert.equal(F.controlDeviationMetaText({ updatedAt: 'geen datum' }), '');
    assert.equal(F.controlDeviationMetaText(null), '');
  });
});

describe('gemotiveerde afwijkingen: weergave en XSS (OWASP A03, DOEL-64)', () => {
  const payloads = ['<img src=x onerror=alert(1)>', '"><svg onload=alert(2)>', 'javascript:alert(3)', "' onmouseover='alert(4)"];
  const noInjected = (html) => {
    for (const t of html.match(/<[^>]*>/g) || []) {
      assert.doesNotMatch(t, /^<\/?(img|script|svg|a|iframe)\b/i, `geïnjecteerde tag: ${t}`);
      assert.doesNotMatch(t, /\son[a-z]+\s*=/i, `geïnjecteerde handler: ${t}`);
      assert.doesNotMatch(t, /javascript:/i, `javascript:-URL in een tag: ${t}`);
    }
  };
  const violations = payloads.map((p, i) => ({
    ruleId: 'R' + i, label: 'Label ' + i, explanation: '', detail: 'detail',
    deviation: { elementCode: 'E1', ruleId: 'R' + i, motivatie: p, updatedAt: '2026-10-02T08:00:00Z', updatedByEmail: p },
  }));

  it('detailpaneel: motivatie en e-mailadres ge-escaped; grijze variant; knoppen alleen met schrijfrecht', () => {
    const edit = F.controlRuleViolationsHtml(violations, { canEdit: true, elementCode: 'E1' });
    noInjected(edit);
    assert.match(edit, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(edit, /class="dp-rules dp-rules-motivated"/);
    assert.match(edit, /Gemotiveerd afgeweken/);
    assert.equal((edit.match(/data-dev-action="edit"/g) || []).length, 4);
    assert.equal((edit.match(/data-dev-action="remove"/g) || []).length, 4);

    const read = F.controlRuleViolationsHtml(violations, { canEdit: false, elementCode: 'E1' });
    noInjected(read);
    assert.doesNotMatch(read, /data-dev-action|<button|<textarea/);
    assert.match(read, /Gemotiveerd afgeweken/, 'bezoeker ziet de motivatie wel');
    // Zonder opts (oude aanroep) ook geen knoppen.
    assert.doesNotMatch(F.controlRuleViolationsHtml(violations), /data-dev-action/);
  });

  it('open overtreding: knop "Motiveer afwijking" alleen met schrijfrecht; element-code/regel-id ge-escaped in data-attributen', () => {
    const open = [{ ruleId: 'R"><b', label: 'l', explanation: '', detail: 'd', deviation: null }];
    const html = F.controlRuleViolationsHtml(open, { canEdit: true, elementCode: 'E"1<x>' });
    noInjected(html);
    assert.match(html, /Motiveer afwijking/);
    assert.match(html, /data-code="E&quot;1&lt;x&gt;" data-rule-id="R&quot;&gt;&lt;b"/);
    assert.doesNotMatch(html, /dp-rules-motivated/);
    assert.doesNotMatch(F.controlRuleViolationsHtml(open, { canEdit: false, elementCode: 'E1' }), /Motiveer afwijking/);
  });

  it('invoerformulier: bestaande motivatie ge-escaped in de textarea, vaste hint, teller en maxlength 500', () => {
    for (const p of payloads.concat(['</textarea><script>alert(5)</script>'])) {
      const html = F.controlRuleDeviationFormHtml('E1', 'R1', p);
      noInjected(html);
      assert.equal((html.match(/<\/textarea>/g) || []).length, 1, 'payload kan de textarea niet sluiten');
    }
    const html = F.controlRuleDeviationFormHtml('E1', 'R1', 'abc');
    assert.equal(F.CONTROL_DEVIATION_MAX_LENGTH, 500);
    assert.match(html, /maxlength="500"/);
    assert.match(html, />3 \/ 500</);
    assert.match(F.CONTROL_DEVIATION_HINT, /geen inhoudelijke, gevoelige of gerubriceerde informatie/);
    assert.ok(html.includes(F.CONTROL_DEVIATION_HINT));
    assert.match(html, /data-dev-action="save"/);
    assert.match(html, /data-dev-action="cancel"/);
    // Het formulier verschijnt alleen voor de regel die bewerkt wordt, en alleen met schrijfrecht.
    const two = [violations[0], { ...violations[1], deviation: null }];
    const editing = F.controlRuleViolationsHtml(two, { canEdit: true, elementCode: 'E1', editingRuleId: 'R1' });
    assert.equal((editing.match(/<textarea/g) || []).length, 1);
    assert.doesNotMatch(F.controlRuleViolationsHtml(two, { canEdit: false, elementCode: 'E1', editingRuleId: 'R1' }), /<textarea/);
  });

  it('hover-kaartje: motivatie ge-escaped, gemarkeerd als gemotiveerd', () => {
    const html = F.controlRuleHintHtml(violations);
    noInjected(html);
    assert.match(html, /tt-rules tt-rules-motivated/);
    assert.match(html, /Gemotiveerd afgeweken: &lt;img src=x onerror=alert\(1\)&gt;/);
    const mixed = F.controlRuleHintHtml([violations[0], { ruleId: 'X', label: 'l', detail: 'd', deviation: null }]);
    assert.doesNotMatch(mixed, /tt-rules-motivated/);
  });

  it('samenvattingspaneel: open en gemotiveerd apart; schakelaar "toon ook gemotiveerde"; standaard alleen open', () => {
    const ev = {
      activeRules: [{ id: 'R1', label: 'Een' }, { id: 'R2', label: payloads[0] }, { id: 'R3', label: 'Drie' }],
      countsByRule: { R1: 2, R2: 0, R3: 0 }, motivatedByRule: { R1: 1, R2: 3, R3: 0 },
      byElement: {}, openElements: 2, motivatedOnlyElements: 3,
    };
    const off = F.controlRulesSummaryHtml(ev, false);
    noInjected(off);
    assert.match(off, />2<\/div><div class="cs-stat-label">Elementen met een overtreding/);
    assert.match(off, />3<\/div><div class="cs-stat-label">Elementen gemotiveerd afgeweken/);
    assert.match(off, /1 gemotiveerd afgeweken/);
    assert.match(off, /3 gemotiveerd afgeweken/);
    assert.match(off, /id="crs-show-motivated">/, 'schakelaar standaard uit');
    // R2 heeft alleen gemotiveerde afwijkingen: niet klikbaar zolang de schakelaar uit staat.
    assert.match(off, /crs-motivated" data-rule-id="R2" disabled/);
    const on = F.controlRulesSummaryHtml(ev, true);
    assert.match(on, /id="crs-show-motivated" checked>/);
    assert.match(on, /crs-motivated" data-rule-id="R2"><div/);
    assert.match(on, /crs-ok" data-rule-id="R3" disabled/);
    // Zonder gemotiveerde afwijkingen geen schakelaar en geen extra tegel (weergave van DOEL-63).
    const none = F.controlRulesSummaryHtml({ activeRules: [{ id: 'R1', label: 'Een' }], countsByRule: { R1: 1 }, byElement: { a: [1] } });
    assert.doesNotMatch(none, /crs-show-motivated|gemotiveerd/);
  });

  it('geen inline handlers in de nieuwe functies en de afhandeling (CSP)', () => {
    const fns = ['controlRuleDeviationFormHtml', 'controlRuleViolationsHtml', 'controlRulesSummaryHtml', 'controlRuleHintHtml'].map(grab).join('\n');
    assert.doesNotMatch(fns, /\son[a-z]+=|javascript:/i);
    const handler = extract(/\/\/ ---- Gemotiveerde afwijking \(DOEL-64\) ----[\s\S]*?\n  if \(controlRulesBtn\) \{/, 'afhandeling afwijking');
    assert.doesNotMatch(handler, /innerHTML|setAttribute\('on|\.on[a-z]+ = /);
    assert.match(handler, /encodeURIComponent\(code\)/);
    assert.match(handler, /encodeURIComponent\(ruleId\)/);
  });

  it('SVG-export: grijs symbool voor gemotiveerd, nooit motivatietekst', () => {
    const block = extract(/const ruleIcon = node\.querySelector\('\.node-rule-icon'\);[\s\S]*?content\.appendChild\(g\);/, 'SVG rule-icon-blok');
    assert.match(block, /classList\.contains\('motivated'\) \? '#8a8f98' : '#ff8c1a'/);
    assert.doesNotMatch(block, /innerHTML|motivatie|deviation|label|explanation/);
  });

  it('statische HTML-export bevat de status, maar geen motivatietekst of e-mailadres', () => {
    const block = extract(/const exportTree = Object\.assign\(\{\}, lastTreeResponse, \{[\s\S]*?\}\);\n/, 'exportTree');
    assert.match(block, /motivatie: '\(motivatie niet opgenomen in de export\)'/);
    assert.doesNotMatch(block, /updatedByEmail|dv\.motivatie/);
    assert.match(source, /JSON\.stringify\(exportTree\)/);
    assert.doesNotMatch(source, /__STATIC_TREE__ = ' \+ JSON\.stringify\(lastTreeResponse\)/);
  });
});

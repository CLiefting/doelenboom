// Regressietest voor SEC-001 (stored XSS in web/public/tree.html — zie
// claude/memo-review in de projectkennis en het "begin met sec-001"-traject).
//
// tree.html is een losstaand, ~8850 regels vanilla-JS-bestand zonder eigen
// buildstap of testinfrastructuur (geen jsdom/vitest in web/) — zie ook
// TECH-004 uit de code-review-memo ("nauwelijks geautomatiseerde dekking op
// het frontend"). In plaats van daar een heel testframework voor optuigen,
// toetst dit bestand het ECHTE, uitgeleverde bronbestand op twee manieren,
// puur met Node's ingebouwde test runner (geen extra dependency nodig):
//
//   1. Functioneel: de escapeHtml()-helper wordt uit tree.html geëxtraheerd
//      en daadwerkelijk uitgevoerd tegen een reeks bekende XSS-payloads, om
//      te bevestigen dat de kernverdediging zelf correct werkt.
//   2. Structureel: elke sink die bij SEC-001 is gefixed (fieldHtml,
//      renderDetailPanel, showTooltip, orgChipsHtml/orgChipsInlineHtml,
//      nodeInnerHtml se capstone-titel) wordt in de brontekst gecontroleerd
//      op het gebruik van escapeHtml() rond het betreffende veld — zodat een
//      toekomstige wijziging die de escaping per ongeluk weer weghaalt
//      (bijvoorbeeld tijdens een refactor) hier faalt i.p.v. pas in productie
//      aan het licht te komen.
//
// Uitvoeren: node --test web/test/tree-html-xss.test.mjs (vanuit de repo-
// root, geen build/install nodig — puur Node 18+ ingebouwd).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TREE_HTML_PATH = path.join(__dirname, '..', 'public', 'tree.html');
const source = readFileSync(TREE_HTML_PATH, 'utf8');

// --- 1. escapeHtml zelf, geëxtraheerd en écht uitgevoerd -------------------

function extractEscapeHtml(src) {
  const match = src.match(/function escapeHtml\(s\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'escapeHtml(s) functie niet gevonden in tree.html — is de functie hernoemd/verplaatst?');
  // eslint-disable-next-line no-new-func
  return new Function(`${match[0]}\nreturn escapeHtml;`)();
}

const escapeHtml = extractEscapeHtml(source);

const XSS_PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<script>alert(1)</script>',
  '"><script>alert(document.cookie)</script>',
  "'><img src=x onerror=alert(1)>",
  '<a href="javascript:alert(1)">klik</a>',
  '<iframe src="javascript:alert(1)"></iframe>',
  'test & <b>bold</b> "quoted" \'single\'',
];

describe('escapeHtml() — kernverdediging tegen stored XSS (SEC-001)', () => {
  for (const payload of XSS_PAYLOADS) {
    it(`neutraliseert: ${payload}`, () => {
      const escaped = escapeHtml(payload);
      assert.ok(!escaped.includes('<'), `"<" niet ge-escaped in: ${escaped}`);
      assert.ok(!escaped.includes('>'), `">" niet ge-escaped in: ${escaped}`);
      assert.ok(!/<script/i.test(escaped), `<script niet geneutraliseerd in: ${escaped}`);
      assert.ok(!/<img/i.test(escaped), `<img niet geneutraliseerd in: ${escaped}`);
      assert.ok(!/<svg/i.test(escaped), `<svg niet geneutraliseerd in: ${escaped}`);
    });
  }

  it('escaped &, <, >, " en \' correct (en dubbel niet dubbel)', () => {
    assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  });

  it('behandelt null/undefined als lege string', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });

  it('laat gewone tekst (incl. leestekens/emoji) intact', () => {
    assert.equal(escapeHtml('Klantgezondheid: risico (30% korting)'), 'Klantgezondheid: risico (30% korting)');
  });
});

// --- 2. Structurele regressiebewaking van de 5 gefixte sinks ---------------
//
// Elke check hieronder pakt de functie-body uit de bron (tussen twee
// markeringen) en controleert dat de relevante user-controlled velden door
// escapeHtml() gaan. Dit is bewust een tekst-/regexcontrole i.p.v. een echte
// DOM-render (geen jsdom-dependency) — voldoende om een toekomstige
// "iemand haalt escapeHtml() weer weg"-regressie te vangen.

function extractFunctionBody(src, functionSignaturePattern) {
  const match = src.match(functionSignaturePattern);
  assert.ok(match, `Functie niet gevonden voor patroon: ${functionSignaturePattern}`);
  return match[0];
}

describe('Structurele regressiebewaking — gefixte SEC-001 sinks blijven escapen', () => {
  it('fieldHtml(label, value) escaped value', () => {
    const body = extractFunctionBody(source, /function fieldHtml\(label, value\) \{[\s\S]*?\n\s{2}\}/);
    assert.match(body, /escapeHtml\(value\)/, 'fieldHtml escaped "value" niet (meer) — regressie op SEC-001-fix.');
  });

  it('renderDetailPanel escaped d.code/d.type/d.name/d.desc in de innerHTML', () => {
    const idx = source.indexOf('function renderDetailPanel');
    assert.ok(idx !== -1, 'renderDetailPanel niet gevonden');
    const body = source.slice(idx, idx + 4000);
    for (const field of ['d.code', 'd.type', 'd.name', 'd.desc']) {
      assert.match(
        body,
        new RegExp(`escapeHtml\\(${field.replace('.', '\\.')}(\\s*\\|\\|[^)]*)?\\)`),
        `renderDetailPanel escaped ${field} niet (meer) — regressie op SEC-001-fix.`
      );
    }
  });

  it('showTooltip escaped d.code/d.type/d.name/d.desc in de innerHTML', () => {
    const idx = source.indexOf('function showTooltip');
    assert.ok(idx !== -1, 'showTooltip niet gevonden');
    const body = source.slice(idx, idx + 4000);
    for (const field of ['d.code', 'd.type', 'd.name', 'd.desc']) {
      assert.match(
        body,
        new RegExp(`escapeHtml\\(${field.replace('.', '\\.')}\\)`),
        `showTooltip escaped ${field} niet (meer) — regressie op SEC-001-fix.`
      );
    }
  });

  it('orgChipsHtml en orgChipsInlineHtml escapen het title-attribuut via escapeHtml()', () => {
    for (const fnName of ['orgChipsHtml', 'orgChipsInlineHtml']) {
      const idx = source.indexOf(`function ${fnName}`);
      assert.ok(idx !== -1, `${fnName} niet gevonden`);
      const body = source.slice(idx, idx + 1500);
      assert.match(
        body,
        /const title = escapeHtml\(|title="\s*'\s*\+\s*escapeHtml\(/,
        `${fnName} bouwt het title-attribuut niet (meer) via escapeHtml() — regressie op SEC-001-fix (bespoke .replace(/"/g,...) is onvoldoende).`
      );
      assert.doesNotMatch(
        body,
        /\.replace\(\/"\/g,\s*['"]&quot;['"]\)/,
        `${fnName} lijkt terug te zijn naar de onvolledige bespoke "-only escaping.`
      );
    }
  });

  it('nodeInnerHtml escaped col.title in de capstone-tak', () => {
    const idx = source.indexOf('function nodeInnerHtml');
    assert.ok(idx !== -1, 'nodeInnerHtml niet gevonden');
    const body = source.slice(idx, idx + 6000);
    assert.match(
      body,
      /escapeHtml\(col\.title\)\.toUpperCase\(\)/,
      'nodeInnerHtml escaped col.title niet (meer) in de capstone-tak — regressie op SEC-001-fix.'
    );
  });
});

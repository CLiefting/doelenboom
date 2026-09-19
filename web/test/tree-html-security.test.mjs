// Regressietest voor DOEL-21 (analyse H2): de keten "?api=&token=-fallback +
// onge-escapete velden + postMessage van elke origin" in web/public/tree.html.
//
// Net als tree-html-xss.test.mjs toetst dit bestand het ECHTE, uitgeleverde
// bronbestand met alleen Node's ingebouwde testrunner (geen jsdom):
//   1. functioneel: het message-handler-blok wordt uit tree.html gehaald en
//      in een kale sandbox uitgevoerd met geldige/ongeldige afzenders;
//   2. structureel: initFromQuery, postMessage-doelen en de eerder onge-
//      escapete sinks worden in de brontekst gecontroleerd.
//
// Uitvoeren: node --test web/test/tree-html-security.test.mjs

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

// --- 1. message-handler (c) -------------------------------------------------

function runInitHandler({ event, origin = 'https://app.example' }) {
  const body = extract(
    /window\.addEventListener\('message', \(event\) => \{\n([\s\S]*?)\n  \}\);/,
    "message-handler ('doelenboom-init')"
  )[1];
  const parent = { name: 'parent' };
  const calls = [];
  const scope = {
    window: { parent, location: { origin } },
    PARENT_ORIGIN: '',
    apiUrl: null, authToken: null, doelenboomId: null, userEmail: null,
    applyRole: (r) => calls.push(['applyRole', r]),
    renderTopbarUser: () => calls.push(['renderTopbarUser']),
    fetchAndBoot: () => calls.push(['fetchAndBoot']),
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('scope', 'event', `with (scope) {\n${body}\n}`);
  fn(scope, typeof event === 'function' ? event(parent) : event);
  return { scope, calls, parent };
}

const initData = { type: 'doelenboom-init', apiUrl: 'https://evil.example', token: 'gestolen', doelenboomId: '7', role: 'admin' };

describe('doelenboom-init message-handler accepteert alleen de eigen parent op dezelfde origin', () => {
  it('accepteert het bericht van de parent-frame op dezelfde origin', () => {
    const { scope, calls } = runInitHandler({
      event: (parent) => ({ data: { ...initData, apiUrl: 'https://app.example' }, source: parent, origin: 'https://app.example' }),
    });
    assert.equal(scope.authToken, 'gestolen');
    assert.equal(scope.PARENT_ORIGIN, 'https://app.example');
    assert.ok(calls.some((c) => c[0] === 'fetchAndBoot'));
  });

  it('negeert een bericht van een andere origin', () => {
    const { scope, calls } = runInitHandler({
      event: (parent) => ({ data: initData, source: parent, origin: 'https://evil.example' }),
    });
    assert.equal(scope.authToken, null);
    assert.equal(scope.apiUrl, null);
    assert.equal(calls.length, 0);
  });

  it('negeert een bericht van een ander venster (bv. opener/popup) ook al is de origin gelijk', () => {
    const { scope, calls } = runInitHandler({
      event: () => ({ data: initData, source: { name: 'ander-venster' }, origin: 'https://app.example' }),
    });
    assert.equal(scope.authToken, null);
    assert.equal(calls.length, 0);
  });

  it('negeert berichten met een ander type of zonder data', () => {
    for (const data of [undefined, null, { type: 'iets-anders' }]) {
      const { scope, calls } = runInitHandler({
        event: (parent) => ({ data, source: parent, origin: 'https://app.example' }),
      });
      assert.equal(scope.authToken, null);
      assert.equal(calls.length, 0);
    }
  });
});

// --- 2. postMessage-doelen --------------------------------------------------

describe("postMessage naar de parent gebruikt nooit een '*'-doel (behalve file://-fallback)", () => {
  it("geen postMessage(..., '*') in tree.html", () => {
    assert.ok(!/postMessage\([^;]*,\s*'\*'\s*\)/.test(source), "postMessage met doel '*' gevonden");
  });

  it('PARENT_ORIGIN valt terug op de eigen origin i.p.v. op *', () => {
    const line = extract(/let PARENT_ORIGIN = ([^\n]+);/, 'PARENT_ORIGIN-declaratie')[1];
    assert.match(line, /window\.location\.origin/);
  });

  it("'doelenboom-ready' gaat naar PARENT_ORIGIN", () => {
    assert.match(source, /postMessage\(\{ type: 'doelenboom-ready' \}, PARENT_ORIGIN\)/);
  });
});

// --- 3. initFromQuery (a) ---------------------------------------------------

describe('initFromQuery (?api=&token=) is alleen actief op een lokale ontwikkelhost', () => {
  const block = extract(/\(function initFromQuery\(\) \{([\s\S]*?)\n  \}\)\(\);/, 'initFromQuery')[1];

  it('controleert de hostnaam vóórdat de querystring gelezen wordt', () => {
    const hostCheck = block.indexOf('isLocalDevHost');
    const readParams = block.indexOf("params.get('api')");
    assert.ok(hostCheck !== -1 && readParams !== -1 && hostCheck < readParams);
    assert.match(block, /localhost/);
    assert.match(block, /if \(!isLocalDevHost\) return;/);
  });

  it('laat alleen http(s)-API-adressen toe', () => {
    assert.match(block, /\^https\?:/);
  });
});

// --- 4. eerder onge-escapete sinks (b) --------------------------------------

describe('vertraging/duur-velden komen niet meer ongeëscaped in innerHTML', () => {
  it('productDepsList: lagAmount/lagEenheid via escapeHtml', () => {
    assert.match(source, /escapeHtml\(\(d\.lagAmount > 0 \? '\+' : ''\) \+ d\.lagAmount \+ \(d\.lagEenheid \|\| 'd'\)\)/);
  });

  it('activityDepsList: lagDays via escapeHtml', () => {
    assert.match(source, /const lagSuffix = d\.lagDays \? escapeHtml\(/);
  });

  it('productkaart: extra regel (deadline/duur) wordt per onderdeel geëscaped', () => {
    assert.match(source, /extraParts\.map\(escapeHtml\)\.join\(' &middot; '\)/);
  });

  it('Gantt-labels (verwacht/opgeleverd/deadline/duur) worden bij het opbouwen geëscaped', () => {
    for (const key of ['verwachtLabel', 'werkelijkLabel', 'deadlineLabel', 'durationLabel']) {
      const line = extract(new RegExp(`${key}: ([^\\n]+)`), key)[1];
      assert.match(line, /escapeHtml\(/, `${key} is niet geëscaped: ${line}`);
    }
  });

  it('formatDateNL/formatDateTimeNL geven een onparseerbare waarde nooit met HTML-tekens terug', () => {
    assert.ok(!/if \(isNaN\(t\)\) return iso;/.test(source), 'formatDate*NL geeft nog de kale invoer terug');
    assert.equal((source.match(/if \(isNaN\(t\)\) return stripHtmlChars\(iso\);/g) || []).length, 2);
  });

  it('afhankelijkheden worden bij het inlezen naar getal/enum gedwongen', () => {
    assert.match(source, /lagAmount: safeNumber\(d\.lagAmount\), lagEenheid: safeDuurEenheid\(d\.lagEenheid\)/);
    assert.match(source, /lagDays: safeNumber\(d\.lagDays\)/);
  });

  it('safeNumber/safeDuurEenheid/stripHtmlChars doen wat ze beloven', () => {
    const grab = (name) => extract(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`), name)[0];
    // eslint-disable-next-line no-new-func
    const h = new Function(
      `${grab('stripHtmlChars')}\n${grab('safeNumber')}\n${grab('safeDuurEenheid')}\nreturn { stripHtmlChars, safeNumber, safeDuurEenheid };`
    )();
    assert.equal(h.safeNumber('<img src=x onerror=alert(1)>'), 0);
    assert.equal(h.safeNumber('12'), 12);
    assert.equal(h.safeNumber(undefined), 0);
    assert.equal(h.safeNumber(Infinity), 0);
    assert.equal(h.safeDuurEenheid('<svg>'), 'd');
    assert.equal(h.safeDuurEenheid('w'), 'w');
    assert.equal(h.stripHtmlChars('a<b>"c\'&`d'), 'abcd');
  });

  // Generieke vangnet-lint: een regel die een vertraging/eenheid-veld direct
  // aan een tekst-literal plakt moet geëscaped zijn, of expliciet op deze
  // lijst staan omdat het resultaat pas later (wél) door escapeHtml gaat.
  it('geen nieuwe ongeëscapete concatenatie van lag*/duurEenheid-velden', () => {
    const risky = /(?:'[^'\n]*'|"[^"\n]*")\s*\+\s*\(?\s*(?:[A-Za-z_$][\w$]*\.)+(?:lagAmount|lagEenheid|lagDays|duurEenheid)\b/;
    const allowed = [
      // productDependencyHint: de hele hint gaat bij elke aanroep door escapeHtml(...)
      /vertraging '\s*\+/,
      // planningsconflict-titel: warnTitle gaat door escapeHtml(warnTitle)
      /const lagLabel = dep\.lagAmount/,
      // duur-regel op de tile: extraParts.map(escapeHtml)
      /extraParts\.push\('Duur: '/,
    ];
    const offenders = source.split('\n').filter((line) => {
      const t = line.trim();
      if (t.startsWith('//') || !risky.test(line) || /escapeHtml\(/.test(line)) return false;
      return !allowed.some((re) => re.test(line));
    });
    assert.deepEqual(offenders, [], `Onge-escapete lag*/duurEenheid-concatenatie:\n${offenders.join('\n')}`);
  });
});

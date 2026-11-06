// Regressietest voor DOEL-140: samengestelde elementen in web/public/tree.html.
//
// Toetst het ECHTE bronbestand: de pure hulpfuncties worden uit tree.html
// gehaald en in een kale sandbox uitgevoerd (zelfde opzet als
// tree-html-alias.test.mjs). Dekt het tekenen van kaders, de regels die de
// boom vooraf toetst (de server toetst ze opnieuw) en A03-escaping.
//
// Uitvoeren: node --test web/test/tree-html-composite.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(__dirname, '..', 'public', 'tree.html'), 'utf8');

const grab = (name) => {
  const m = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} niet gevonden in tree.html — is het hernoemd/verplaatst?`);
  return m[0];
};

const NAMES = [
  'escapeHtml', 'nodeInnerHtml', 'buildColumnsHtml', 'composedPartsOf', 'partsCountText', 'edgeAnchorId',
  'partOfCandidates', 'partOfOptionsHtml', 'suggestPartCode', 'linksLostByTypeChange', 'composeSelectionCheck',
  'unselectedPartsOf', 'compositionPanelHtml', 'composeWholeOptionsHtml', 'composeTypeOptionsHtml',
  'frameCollapseStorageKey', 'loadCollapsedFrames', 'saveCollapsedFrames',
];

function load(storage) {
  // eslint-disable-next-line no-new-func
  return new Function('localStorage', 'doelenboomId',
    NAMES.map(grab).join('\n') + `\nreturn { ${NAMES.join(', ')} };`
  )(storage, '7');
}
const H = load({ getItem: () => null, setItem: () => {} });

const XSS = '"><img src=x onerror=alert(1)>';
const noRawHtml = (html) => {
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /onerror=alert\(1\)>/);
};

const col = (typeName, aliases = []) => ({ typeName, title: typeName, subtitle: '', color: '#0000FF', isNarrow: false, aliases });
const columns = [col('Capability', [{ typeName: 'Voorziening', color: null }]), col('Project')];
const typeToColumn = { Capability: columns[0], Voorziening: columns[0], Project: columns[1] };
const el = (code, type, partOf = null, name = 'Naam ' + code) => ({ code, type, name, partOf });
const details = (...els) => Object.fromEntries(els.map((e) => [e.code, e]));

// Volgorde van kaders, vakken en labels in de HTML, als ['F:C1', 'C1', 'C2', 'L:Voorziening', ...].
function sequence(html) {
  const out = [];
  const re = /<div class="(node-frame" data-whole|node" data-id|col-group-label" data-group)="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    const kind = m[1].split('"')[0];
    out.push(kind === 'node-frame' ? 'F:' + m[2] : kind === 'col-group-label' ? 'L:' + m[2] : m[2]);
  }
  return out;
}

describe('buildColumnsHtml tekent samengestelde elementen als kader (DOEL-140)', () => {
  it('het geheel is de kop van het kader, de delen staan erin en nergens anders', () => {
    const d = details(el('C2', 'Capability', 'C1'), el('C1', 'Capability'), el('C3', 'Capability'), el('C4', 'Capability', 'C1'));
    const html = H.buildColumnsHtml(d, columns);
    assert.deepEqual(sequence(html), ['F:C1', 'C1', 'C2', 'C4', 'C3']);
    assert.equal((html.match(/data-id="C2"/g) || []).length, 1, 'een deel staat één keer in de boom');
    assert.match(html, /data-id="C2" data-group="Capability" data-part-of="C1"/);
    assert.match(html, /class="frame-count">2 delen</);
    assert.match(html, /class="frame-toggle" data-whole="C1"/);
  });

  it('het kader staat in de aliasgroep van het geheel, ook met delen van een ander type', () => {
    const d = details(el('C1', 'Capability'), el('V1', 'Voorziening'), el('V2', 'Voorziening', 'V1'), el('C2', 'Capability', 'V1'));
    const html = H.buildColumnsHtml(d, columns);
    assert.deepEqual(sequence(html), ['C1', 'L:Voorziening', 'F:V1', 'V1', 'V2', 'C2']);
  });

  it('een koppeling naar een andere kolom, een onbekend geheel of nesting wordt genegeerd (gewoon vak)', () => {
    const d = details(
      el('C1', 'Capability'), el('C2', 'Capability', 'C1'),
      el('C3', 'Capability', 'C2'), // nesting: C2 is zelf een deel
      el('C4', 'Capability', 'P1'), // andere kolom
      el('C5', 'Capability', 'ONBEKEND'),
      el('P1', 'Project'),
    );
    const html = H.buildColumnsHtml(d, columns);
    const caps = sequence(html.slice(0, html.indexOf('data-key="Project"')));
    assert.deepEqual(caps, ['F:C1', 'C1', 'C2', 'C3', 'C4', 'C5']);
    assert.doesNotMatch(html, /data-id="C3"[^>]*data-part-of/);
  });

  it('A03: codes en namen in kader-attributen en teller worden ge-escaped', () => {
    const d = details(el(XSS, 'Capability', null, XSS), el('C2', 'Capability', XSS, XSS));
    const html = H.buildColumnsHtml(d, columns);
    noRawHtml(html);
    assert.match(html, /data-whole="&quot;&gt;&lt;img/);
  });

  it('composedPartsOf: delen in boomvolgorde; zichzelf als geheel telt niet', () => {
    const r = H.composedPartsOf([el('C3', 'Capability', 'C1'), el('C1', 'Capability'), el('C2', 'Capability', 'C1'), el('C9', 'Capability', 'C9')]);
    assert.deepEqual(r.parts.C1.map((x) => x.code), ['C3', 'C2']);
    assert.equal(r.isPart.C9, undefined);
  });

  it('partsCountText: enkelvoud en meervoud', () => {
    assert.equal(H.partsCountText(1), '1 deel');
    assert.equal(H.partsCountText(3), '3 delen');
  });
});

describe('regels in de boom (DOEL-140; de server toetst ze opnieuw)', () => {
  const d = details(el('C1', 'Capability'), el('C2', 'Capability', 'C1'), el('V1', 'Voorziening'), el('P1', 'Project'), el('C1.1', 'Capability'));

  it('"Onderdeel van" biedt alleen elementen uit dezelfde kolom die zelf geen deel zijn, niet zichzelf', () => {
    assert.deepEqual(H.partOfCandidates(d, typeToColumn, 'Capability', 'V1'), ['C1', 'C1.1']);
    assert.deepEqual(H.partOfCandidates(d, typeToColumn, 'Project', null), ['P1']);
    const html = H.partOfOptionsHtml(['C1'], d, 'C1');
    assert.match(html, /<option value="">Geen \(gewoon element\)<\/option><option value="C1" selected>C1 — Naam C1<\/option>/);
  });

  it('codevoorstel voor een nieuw deel: eerstvolgende vrije <geheel>.n', () => {
    assert.equal(H.suggestPartCode('C1', d), 'C1.2');
    assert.equal(H.suggestPartCode('P1', d), 'P1.1');
  });

  it('een typewissel naar een andere kolom noemt de koppelingen die vervallen; een alias in dezelfde kolom niet', () => {
    assert.deepEqual(H.linksLostByTypeChange(d, typeToColumn, 'C1', 'Project'), ['C2']);
    assert.deepEqual(H.linksLostByTypeChange(d, typeToColumn, 'C2', 'Project'), ['C1']);
    assert.deepEqual(H.linksLostByTypeChange(d, typeToColumn, 'C2', 'Voorziening'), []);
    assert.deepEqual(H.linksLostByTypeChange(d, typeToColumn, 'P1', 'Capability'), []);
  });

  it('samenvoegen: alleen binnen één kolom en met hooguit één samengesteld element in de selectie', () => {
    assert.equal(H.composeSelectionCheck(['C1', 'V1'], d, typeToColumn).error, null);
    assert.equal(H.composeSelectionCheck(['C1', 'V1'], d, typeToColumn).column.typeName, 'Capability');
    assert.match(H.composeSelectionCheck(['C1', 'P1'], d, typeToColumn).error, /één kolom/);
    const two = details(el('C1', 'Capability'), el('C2', 'Capability', 'C1'), el('C3', 'Capability'), el('C4', 'Capability', 'C3'));
    assert.match(H.composeSelectionCheck(['C1', 'C3'], two, typeToColumn).error, /meer dan één samengesteld element/);
    assert.match(H.composeSelectionCheck(['X'], d, typeToColumn).error, /geen enkele kolom/);
  });

  it('bulk-verwijderen: delen van geselecteerde gehelen die zelf niet geselecteerd zijn', () => {
    const many = details(el('C1', 'Capability'), el('C2', 'Capability', 'C1'), el('C3', 'Capability', 'C1'));
    assert.deepEqual(H.unselectedPartsOf(['C1', 'C3'], many), ['C2']);
    assert.deepEqual(H.unselectedPartsOf(['C2'], many), []);
  });

  it('lijnen van een deel in een ingeklapt kader sluiten aan op het geheel', () => {
    assert.equal(H.edgeAnchorId('C2', d, new Set(['C1'])), 'C1');
    assert.equal(H.edgeAnchorId('C2', d, new Set()), 'C2');
    assert.equal(H.edgeAnchorId('P1', d, new Set(['C1'])), 'P1');
  });
});

describe('detailpaneel en keuzelijsten (DOEL-140) — A03', () => {
  it('een deel toont "Onderdeel van" met Losmaken, een geheel "Bestaat uit" met Alle delen losmaken', () => {
    const d = details(el('C1', 'Capability'), el('C2', 'Capability', 'C1'), el('C3', 'Capability', 'C1'), el('C4', 'Capability'));
    const part = H.compositionPanelHtml(d.C2, d);
    assert.match(part, /Onderdeel van/);
    assert.match(part, /dp-detach-btn" data-code="C2"/);
    const whole = H.compositionPanelHtml(d.C1, d);
    assert.match(whole, /Bestaat uit \(2 delen\)/);
    assert.match(whole, /dp-detach-all-btn" data-code="C1"/);
    assert.equal(H.compositionPanelHtml(d.C4, d), '');
  });

  it('codes, namen en typenamen worden ge-escaped in paneel en keuzelijsten', () => {
    const d = details(el(XSS, 'Capability', null, XSS), el('C2', 'Capability', XSS, XSS));
    noRawHtml(H.compositionPanelHtml(d.C2, d));
    noRawHtml(H.compositionPanelHtml(d[XSS], d));
    noRawHtml(H.composeWholeOptionsHtml([XSS], d));
    noRawHtml(H.composeTypeOptionsHtml([XSS]));
    noRawHtml(H.partOfOptionsHtml([XSS], d, XSS));
  });
});

describe('inklapstand in de browser (DOEL-140)', () => {
  it('per doelenboom; geblokkeerde of kapotte opslag geeft gewoon alles open', () => {
    const store = {};
    const ok = load({ getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } });
    ok.saveCollapsedFrames(new Set(['C1', 'C9']));
    assert.equal(ok.frameCollapseStorageKey(), 'doelenboom-frames-collapsed-7');
    assert.deepEqual([...ok.loadCollapsedFrames()], ['C1', 'C9']);

    store['doelenboom-frames-collapsed-7'] = '{kapot';
    assert.equal(ok.loadCollapsedFrames().size, 0);
    store['doelenboom-frames-collapsed-7'] = JSON.stringify([1, { a: 1 }, 'C3']);
    assert.deepEqual([...ok.loadCollapsedFrames()], ['C3'], 'alleen tekst');

    const blocked = load({ getItem: () => { throw new Error('geblokkeerd'); }, setItem: () => { throw new Error('geblokkeerd'); } });
    assert.equal(blocked.loadCollapsedFrames().size, 0);
    assert.doesNotThrow(() => blocked.saveCollapsedFrames(new Set(['C1'])));
  });
});

// Regressietests voor DOEL-98: "Toon alleen deze N in de boom" (chipfilter →
// boomfilter) en "Filter op resultaten" (zoekbalk → boomfilter) in
// web/public/tree.html.
//
// Na het overzetten moet de boomfilter het beeld bepalen, net als na
// Ctrl/Cmd-klik → "Toon deze bomen": de bron (chipfilter of zoekopdracht)
// wordt gewist, anders blijft alles buiten de matches gedimd (tag-dimmed /
// search-miss), ook binnen de getoonde bomen, en is dat niet meer weg te
// klikken met "Wis".
//
// Aanpak zoals de andere tree-html-tests (geen jsdom): de ECHTE
// click-handlers uit het uitgeleverde bestand halen en met stubs uitvoeren.
//
// Uitvoeren: node --test web/test/tree-html-filter-transfer.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(__dirname, '..', 'public', 'tree.html'), 'utf8');

function handlerBody(btnVar) {
  const re = new RegExp(`\\n  ${btnVar}\\.addEventListener\\('click', \\(\\) => \\{([\\s\\S]*?)\\n  \\}\\);`);
  const m = source.match(re);
  assert.ok(m, `click-handler van ${btnVar} niet gevonden in tree.html — hernoemd/verplaatst?`);
  return m[1];
}

// Voert een handler-body uit met de gegeven stubs als "scope" (via with, dus
// toewijzingen als `lastChipFilterMatchIds = []` komen op ctx terecht).
function run(body, ctx) {
  // eslint-disable-next-line no-new-func
  new Function('ctx', `with (ctx) {${body}\n}`)(ctx);
}

function baseCtx(calls) {
  return {
    filterSelection: new Set(),
    document: {
      querySelector: () => ({ classList: { add() {}, remove() {} } }),
      querySelectorAll: () => [],
    },
    updateFilterStatusUI: () => calls.push('updateFilterStatusUI'),
    applyElementFilter: () => calls.push('applyElementFilter'),
  };
}

describe('DOEL-98: chipfilter overzetten naar de boomfilter', () => {
  const body = handlerBody('filterChipsApplyBtn');

  it('zet alle chipmatches in de boomfilter-selectie en past die toe', () => {
    const calls = [];
    const ctx = {
      ...baseCtx(calls),
      lastChipFilterMatchIds: ['C21', 'C22', 'WS2'],
      activeTagFilters: new Set(['tag:7']),
      applyTagFilter() { calls.push('applyTagFilter'); if (ctx.activeTagFilters.size === 0) ctx.lastChipFilterMatchIds = []; },
    };
    run(body, ctx);
    assert.deepEqual([...ctx.filterSelection].sort(), ['C21', 'C22', 'WS2']);
    assert.ok(calls.includes('applyElementFilter'));
  });

  it('wist daarna de chipfilter, zodat niets binnen de bomen gedimd blijft', () => {
    const calls = [];
    const ctx = {
      ...baseCtx(calls),
      lastChipFilterMatchIds: ['C21', 'C22'],
      activeTagFilters: new Set(['tag:7', 'org:3']),
      applyTagFilter() { calls.push('applyTagFilter'); if (ctx.activeTagFilters.size === 0) ctx.lastChipFilterMatchIds = []; },
    };
    run(body, ctx);
    assert.equal(ctx.activeTagFilters.size, 0, 'chipfilter staat nog aan → tag-dimmed blijft');
    assert.ok(calls.includes('applyTagFilter'), 'applyTagFilter niet aangeroepen → tag-dimmed blijft op de vakken');
    // De picks mogen niet verloren gaan doordat de chipfilter eerst geleegd wordt.
    assert.deepEqual([...ctx.filterSelection].sort(), ['C21', 'C22']);
  });

  it('knoplabel zegt dat de bomen getoond worden, niet "alleen deze N"', () => {
    assert.match(source, /filterChipsApplyBtn\.textContent = 'Toon de bomen van deze ' \+ idSet\.size/);
    assert.doesNotMatch(source, /'Toon alleen deze '/);
  });
});

describe('DOEL-98: zoekresultaten overzetten naar de boomfilter', () => {
  const body = handlerBody('filterFromSearchBtn');

  it('zet de treffers in de boomfilter en wist daarna de zoekopdracht', () => {
    const calls = [];
    const ctx = {
      ...baseCtx(calls),
      lastSearchMatchIds: ['OB1', 'C12'],
      searchInput: { value: 'account' },
      runSearch() { calls.push('runSearch'); if (ctx.searchInput.value === '') ctx.lastSearchMatchIds = []; },
    };
    run(body, ctx);
    assert.deepEqual([...ctx.filterSelection].sort(), ['C12', 'OB1']);
    assert.ok(calls.includes('applyElementFilter'));
    assert.equal(ctx.searchInput.value, '', 'zoekopdracht staat nog → search-miss blijft dimmen');
    assert.ok(calls.includes('runSearch'));
  });
});

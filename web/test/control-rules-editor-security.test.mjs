// Regressietest voor DOEL-62 (OWASP A03): de beheer-UI van controleregels
// (web/src/components/ControlRulesEditor.tsx) toont door gebruikers ingevoerde
// tekst (labels, uitleg, typenamen, tag-categorieën). Die moet altijd als
// gewone React-tekst gerenderd worden — React escapet die zelf. Dit bestand
// borgt statisch dat er geen ontsnappingsroutes in sluipen (raw HTML-injectie,
// eval-achtige constructies, inline event-handlers als string) en dat de
// verplichte hint uit het ticket in de UI staat.
//
// Uitvoeren: node --test web/test/control-rules-editor-security.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, '..', 'src', 'components', 'ControlRulesEditor.tsx');
// Commentaar weglaten: dat mag deze termen wél noemen (uitleg waarom ze er niet in staan).
const source = readFileSync(file, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('ControlRulesEditor (DOEL-62)', () => {
  it('rendert gebruikersinvoer nooit als ruwe HTML', () => {
    for (const forbidden of ['dangerouslySetInnerHTML', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      assert.ok(!source.includes(forbidden), `${forbidden} mag niet voorkomen in ControlRulesEditor.tsx`);
    }
  });

  it('gebruikt geen eval-achtige constructies of string-handlers', () => {
    assert.doesNotMatch(source, /\beval\s*\(/);
    assert.doesNotMatch(source, /new Function\s*\(/);
    assert.doesNotMatch(source, /setTimeout\s*\(\s*['"`]/);
    assert.doesNotMatch(source, /\son[a-z]+=\s*["']/i, 'geen inline HTML-eventhandlers als string');
  });

  it('toont de hint "geen inhoudelijke of gerubriceerde informatie"', () => {
    assert.match(source, /Leg alleen structuur vast; geen inhoudelijke of gerubriceerde informatie\./);
  });

  it('kent geen statusregels (de vijf structuurregeltypen plus de kenmerkregel uit DOEL-77)', () => {
    const kinds = [...source.matchAll(/^\s+(requires_outgoing|requires_incoming|primary_parent_count|requires_tag_category|required_field|attribute_condition):/gm)].map((m) => m[1]);
    assert.deepEqual([...new Set(kinds)].sort(), [
      'attribute_condition', 'primary_parent_count', 'required_field', 'requires_incoming', 'requires_outgoing', 'requires_tag_category',
    ]);
  });

  it('kenmerkregel (DOEL-77): dezelfde eisen als de server, hint bij de vrije tekst, melding bij tijdsafhankelijke eisen', () => {
    const api = readFileSync(path.join(__dirname, '..', '..', 'api', 'src', 'controlRules.ts'), 'utf8');
    const serverOps = [...api.matchAll(/^  ([a-z_]+): \{ kind: '[a-z]+', value: '[a-z]+' \},$/gm)].map((m) => m[1]).sort();
    const editorOps = [...source.matchAll(/\{ op: '([a-z_]+)', kind: '[a-z]+', shape: '[a-z]+', label: /g)].map((m) => m[1]).sort();
    assert.equal(serverOps.length, 24);
    assert.deepEqual(editorOps, serverOps);
    assert.match(source, /placeholder="Geen inhoudelijke of gerubriceerde informatie\."\s+onChange=\{\(e\) => set\(\{ value: e\.target\.value \}\)\}/);
    assert.match(source, /getoetst tegen de datum van vandaag/);
    assert.match(source, /mag niet met "req-" beginnen/);
  });
});

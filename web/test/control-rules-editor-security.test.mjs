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

  it('kent geen statusregels (alleen de vijf structuurregeltypen)', () => {
    const kinds = [...source.matchAll(/^\s+(requires_outgoing|requires_incoming|primary_parent_count|requires_tag_category|required_field):/gm)].map((m) => m[1]);
    assert.deepEqual([...new Set(kinds)].sort(), [
      'primary_parent_count', 'required_field', 'requires_incoming', 'requires_outgoing', 'requires_tag_category',
    ]);
  });
});

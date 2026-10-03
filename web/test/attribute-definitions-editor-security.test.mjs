// Regressietest voor DOEL-75 (OWASP A03): de beheer-UI van kenmerkdefinities
// (web/src/components/AttributeDefinitionsEditor.tsx) toont door gebruikers
// ingevoerde tekst (labels, uitleg, keuzelijstwaarden, typenamen). Die moet
// altijd als gewone React-tekst gerenderd worden — React escapet die zelf.
// Dit bestand borgt statisch dat er geen ontsnappingsroutes in sluipen (raw
// HTML-injectie, eval-achtige constructies, inline event-handlers als string),
// dat de verplichte hint uit het ticket in de UI staat en dat de sectie op
// alle drie de niveaus tussen de kolommen en de controleregels hangt.
//
// Uitvoeren: node --test web/test/attribute-definitions-editor-security.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = (...parts) => readFileSync(path.join(__dirname, '..', 'src', ...parts), 'utf8');
// Commentaar weglaten: dat mag deze termen wél noemen (uitleg waarom ze er niet in staan).
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const source = stripComments(src('components', 'AttributeDefinitionsEditor.tsx'));

describe('AttributeDefinitionsEditor (DOEL-75)', () => {
  it('rendert gebruikersinvoer nooit als ruwe HTML', () => {
    for (const forbidden of ['dangerouslySetInnerHTML', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      assert.ok(!source.includes(forbidden), `${forbidden} mag niet voorkomen in AttributeDefinitionsEditor.tsx`);
    }
  });

  it('gebruikt geen eval-achtige constructies of string-handlers', () => {
    assert.doesNotMatch(source, /\beval\s*\(/);
    assert.doesNotMatch(source, /new Function\s*\(/);
    assert.doesNotMatch(source, /setTimeout\s*\(\s*['"`]/);
    assert.doesNotMatch(source, /\son[a-z]+=\s*["']/i, 'geen inline HTML-eventhandlers als string');
  });

  it('toont de hint "geen inhoudelijke of gerubriceerde informatie"', () => {
    assert.match(source, /Leg alleen kenmerken vast die metagegevens zijn; geen inhoudelijke of gerubriceerde informatie\./);
    // Ook bij de vrije-tekstvelden (uitleg en keuzelijst).
    assert.equal((source.match(/placeholder="Geen inhoudelijke of gerubriceerde informatie\."/g) ?? []).length, 2);
  });

  it('kent precies de vijf soorten uit het ontwerp', () => {
    const kinds = [...source.matchAll(/^\s+(text|number|date|choice|boolean): '/gm)].map((m) => m[1]);
    assert.deepEqual([...new Set(kinds)].sort(), ['boolean', 'choice', 'date', 'number', 'text']);
  });

  it('id en soort zijn na opslaan niet te wijzigen in het formulier', () => {
    assert.match(source, /value=\{draft\.id\} disabled=\{!isNew\}/);
    assert.match(source, /value=\{draft\.kind\} disabled=\{kindLocked\}/);
  });

  it('staat in ColumnConfigEditor tussen de kolommen en de controleregels', () => {
    const editor = stripComments(src('components', 'ColumnConfigEditor.tsx'));
    const attributesAt = editor.indexOf('<AttributeDefinitionsEditor');
    const rulesAt = editor.indexOf('<ControlRulesEditor');
    assert.ok(attributesAt > 0 && rulesAt > attributesAt, 'Kenmerken moet vóór Controleregels gerenderd worden');
    assert.ok(attributesAt > editor.indexOf('+ Kolom toevoegen'), 'Kenmerken moet ná de kolommen gerenderd worden');
  });

  it('is aangesloten op doelenboom (verborgen zonder module), tenant-standaard en sjabloon', () => {
    const tenantPage = stripComments(src('pages', 'TenantManagementPage.tsx'));
    assert.match(tenantPage, /api\.doelenboomAttributes\(token, d\.id\),[\s\S]{0,200}?hideWhenModuleInactive: true/);
    assert.match(tenantPage, /api\.tenantAttributes\(token, selectedTenantId\),[\s\S]{0,200}?hideWhenModuleInactive: false/);
    assert.match(stripComments(src('pages', 'DoelenboomTemplatesPage.tsx')), /api\.templateAttributes\(token, template\.id\)/);
  });
});

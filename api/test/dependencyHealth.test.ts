import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifySemverUpdate, classifySeverityLevel } from '../src/dependencyHealth.js';

// Pure unit-tests voor de classificatiefuncties in dependencyHealth.ts (geen
// database/netwerk nodig — dat is het domein van test/systemSbom.test.ts).
// Zie §7/§19 van de SBOM-opdracht: bij twijfel/onherkenbare notatie mag de
// applicatie nooit een verzonnen conclusie tonen, dus 'onbekend' is hier
// bewust het correcte antwoord in een aantal gevallen, geen "not implemented".
describe('dependencyHealth: classifySemverUpdate', () => {
  it('gelijke versie is actueel', () => {
    assert.equal(classifySemverUpdate('1.2.3', '1.2.3'), 'actueel');
  });

  it('nieuwere patch-versie', () => {
    assert.equal(classifySemverUpdate('1.2.3', '1.2.4'), 'patch');
  });

  it('nieuwere minor-versie', () => {
    assert.equal(classifySemverUpdate('1.2.3', '1.3.0'), 'minor');
  });

  it('nieuwere major-versie', () => {
    assert.equal(classifySemverUpdate('1.2.3', '2.0.0'), 'major');
  });

  it('een minor-sprong wint van een gelijktijdige patch-sprong (classificatie kijkt naar het hoogste veld dat verschilt)', () => {
    assert.equal(classifySemverUpdate('1.2.3', '1.3.1'), 'minor');
  });

  it('lokale versie nieuwer dan "laatste" (bv. een prerelease/fork) is ook actueel, geen negatieve update', () => {
    assert.equal(classifySemverUpdate('2.0.0', '1.9.9'), 'actueel');
  });

  it('"v"-prefix en prerelease-suffix worden begrepen', () => {
    assert.equal(classifySemverUpdate('v1.2.3', 'v1.2.4'), 'patch');
    assert.equal(classifySemverUpdate('1.2.3', '1.2.3-beta.1'), 'actueel');
  });

  it('niet-semver notaties geven bewust onbekend, geen giswerk', () => {
    assert.equal(classifySemverUpdate('niet-een-versie', '1.0.0'), 'onbekend');
    assert.equal(classifySemverUpdate('1.0.0', 'ook-geen-versie'), 'onbekend');
    assert.equal(classifySemverUpdate('git+https://example.com', '1.0.0'), 'onbekend');
  });
});

describe('dependencyHealth: classifySeverityLevel', () => {
  it('herkent de vier OSV-ernstwoorden, case-insensitive', () => {
    assert.equal(classifySeverityLevel('CRITICAL'), 'kritiek');
    assert.equal(classifySeverityLevel('critical'), 'kritiek');
    assert.equal(classifySeverityLevel('HIGH'), 'hoog');
    assert.equal(classifySeverityLevel('MODERATE'), 'gemiddeld');
    assert.equal(classifySeverityLevel('MEDIUM'), 'gemiddeld');
    assert.equal(classifySeverityLevel('Low'), 'laag');
  });

  it('geeft onbekend bij ontbrekende of onherkenbare waarde (bv. een kale CVSS-vectorstring)', () => {
    assert.equal(classifySeverityLevel(null), 'onbekend');
    assert.equal(classifySeverityLevel(''), 'onbekend');
    assert.equal(classifySeverityLevel('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), 'onbekend');
    assert.equal(classifySeverityLevel('zeer erg'), 'onbekend');
  });
});

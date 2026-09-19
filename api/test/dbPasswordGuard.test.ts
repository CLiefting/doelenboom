import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDatabasePasswordIsSafe, databasePasswordFromUrl, UnsafeDatabasePasswordError,
} from '../src/dbPasswordGuard.js';

// DOEL-31: in productie geen bekend standaard-databasewachtwoord.

const url = (pw: string) => `postgres://doelenboom:${pw}@db:5432/doelenboom`;

describe('databasewachtwoord-controle (DOEL-31)', () => {
  it('haalt het wachtwoord uit de URL (ook url-encoded) en geeft null bij ontbreken/ongeldige URL', () => {
    assert.equal(databasePasswordFromUrl(url('geheim')), 'geheim');
    assert.equal(databasePasswordFromUrl(url('a%40b%2Fc')), 'a@b/c');
    assert.equal(databasePasswordFromUrl('postgres://doelenboom@db/doelenboom'), null);
    assert.equal(databasePasswordFromUrl('geen url'), null);
    assert.equal(databasePasswordFromUrl(undefined), null);
  });

  it('productie + standaardwachtwoord: weigert (ook in andere hoofdletters)', () => {
    for (const pw of ['doelenboom', 'Doelenboom', 'postgres', 'password', 'changeme']) {
      assert.throws(() => assertDatabasePasswordIsSafe(url(pw), 'production', undefined), UnsafeDatabasePasswordError, pw);
    }
  });

  it('productie + eigen wachtwoord: geen fout', () => {
    assert.doesNotThrow(() => assertDatabasePasswordIsSafe(url('k9V2-x7Qp-Lm4z'), 'production', undefined));
  });

  it('productie zonder wachtwoord in de URL (bv. PG*-variabelen): geen fout', () => {
    assert.doesNotThrow(() => assertDatabasePasswordIsSafe(undefined, 'production', undefined));
  });

  it('buiten productie: alleen een waarschuwing, geen fout', () => {
    for (const env of [undefined, 'development', 'test']) {
      assert.doesNotThrow(() => assertDatabasePasswordIsSafe(url('doelenboom'), env, undefined));
    }
  });

  it('ALLOW_DEFAULT_DB_PASSWORD=true is een expliciete overgangsvlag; andere waarden tellen niet', () => {
    assert.doesNotThrow(() => assertDatabasePasswordIsSafe(url('doelenboom'), 'production', 'true'));
    for (const v of ['1', 'yes', 'false', '']) {
      assert.throws(() => assertDatabasePasswordIsSafe(url('doelenboom'), 'production', v), UnsafeDatabasePasswordError, v);
    }
  });

  it('de foutmelding bevat het wachtwoord zelf niet', () => {
    try {
      assertDatabasePasswordIsSafe(url('changeme'), 'production', undefined);
      assert.fail('had moeten gooien');
    } catch (err) {
      assert.ok(!(err as Error).message.includes('changeme'));
    }
  });
});

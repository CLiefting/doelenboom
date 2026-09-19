import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from '../src/db.js';
import {
  assertNoDefaultAdminPassword, DefaultAdminPasswordError, findAccountsWithDefaultPassword,
} from '../src/startupChecks.js';
import { closePool, unique } from './helpers.js';

// DOEL-23 (analyse H4): het standaard sysadmin-wachtwoord uit seed.sql/README
// mag in productie niet meer werken.

describe('startupChecks — standaard sysadmin-wachtwoord (DOEL-23)', () => {
  const prefix = unique('startchk');
  const adminEmail = `${prefix}-admin@example.com`;
  const editorEmail = `${prefix}-user@example.com`;
  const realWarn = console.warn;
  let warnings: string[] = [];

  before(async () => {
    // Uitgangssituatie: de test-db heeft (init.sql zonder seed) geen account met een default-wachtwoord.
    assert.deepEqual(await findAccountsWithDefaultPassword(), []);
    await pool.query(
      `insert into users (email, password_hash, is_sysadmin, must_change_password)
       values ($1, crypt('changeme', gen_salt('bf')), true, false)`,
      [adminEmail]
    );
    // Gewone gebruiker met dezelfde wachtwoordkeuze telt NIET mee (alleen sysadmin/geseed admin).
    await pool.query(
      `insert into users (email, password_hash, is_sysadmin, must_change_password)
       values ($1, crypt('changeme', gen_salt('bf')), false, false)`,
      [editorEmail]
    );
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  });

  after(async () => {
    console.warn = realWarn;
    await pool.query('delete from users where email like $1', [`${prefix}%`]);
    await closePool();
  });

  it('vindt een sysadmin met het standaardwachtwoord (en geen gewone gebruiker)', async () => {
    assert.deepEqual(await findAccountsWithDefaultPassword(), [adminEmail]);
  });

  it('productie: weigert (gooit DefaultAdminPasswordError) en noemt het account + de oplossing', async () => {
    await assert.rejects(
      () => assertNoDefaultAdminPassword('production'),
      (err: unknown) => {
        assert.ok(err instanceof DefaultAdminPasswordError);
        assert.match(err.message, new RegExp(adminEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(err.message, /crypt\('<nieuw-wachtwoord>'/);
        return true;
      }
    );
  });

  it('niet-productie: alleen een waarschuwing, geen fout', async () => {
    warnings = [];
    for (const env of [undefined, 'development', 'test']) {
      await assert.doesNotReject(() => assertNoDefaultAdminPassword(env));
    }
    assert.ok(warnings.some((w) => w.includes('WAARSCHUWING') && w.includes(adminEmail)));
  });

  it('na het wijzigen van het wachtwoord start productie weer', async () => {
    await pool.query(`update users set password_hash = crypt('een-echt-nieuw-wachtwoord-1', gen_salt('bf')) where email = $1`, [adminEmail]);
    assert.deepEqual(await findAccountsWithDefaultPassword(), []);
    await assert.doesNotReject(() => assertNoDefaultAdminPassword('production'));
  });

  it('het geseede admin@code072.nl-account telt ook mee als het (om welke reden ook) geen sysadmin meer is', async () => {
    await pool.query(
      `insert into users (email, password_hash, is_sysadmin, must_change_password)
       values ('admin@code072.nl', crypt('changeme', gen_salt('bf')), false, false)
       on conflict (email) do update set password_hash = excluded.password_hash, is_sysadmin = false`
    );
    try {
      assert.ok((await findAccountsWithDefaultPassword()).includes('admin@code072.nl'));
    } finally {
      await pool.query(`delete from users where email = 'admin@code072.nl'`);
    }
  });
});

describe('db/seed.sql — geseed admin moet het wachtwoord bij eerste login wijzigen', () => {
  it('zet must_change_password = true voor admin@code072.nl', () => {
    const seed = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'seed.sql'), 'utf8'
    );
    const insert = seed.match(/insert into users \(([^)]*)\)\s*values \('admin@code072\.nl'[^;]*;/i);
    assert.ok(insert, 'seed-insert van admin@code072.nl niet gevonden');
    assert.match(insert[1], /must_change_password/);
    assert.match(insert[0], /true\s*,\s*true\s*\)/);
  });
});

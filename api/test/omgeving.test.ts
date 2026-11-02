// Regressietests voor DOEL-131: de API geeft buiten productie de omgeving door
// (voor de groene/gele driehoek linksboven in de web-app) en weigert te starten
// met een ongeldige DOELENBOOM_OMGEVING. Geen database nodig: /api/version en
// createApp() raken de database niet.
//
// Op de oude code falen deze tests: src/omgeving.ts bestond niet, /api/version
// gaf geen "omgeving" mee en createApp() startte met elke waarde.
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { InvalidOmgevingError, OMGEVINGEN, omgevingVoorWeb, parseOmgeving } from '../src/omgeving.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const original = process.env.DOELENBOOM_OMGEVING;
const restore = () => {
  if (original === undefined) delete process.env.DOELENBOOM_OMGEVING;
  else process.env.DOELENBOOM_OMGEVING = original;
};

describe('DOEL-131: parseOmgeving', () => {
  it('kent precies ontwikkeling, acceptatie en productie', () => {
    assert.deepEqual([...OMGEVINGEN], ['ontwikkeling', 'acceptatie', 'productie']);
    for (const o of OMGEVINGEN) assert.equal(parseOmgeving(o), o);
  });

  it('leeg of niet gezet telt als productie (zelfde regel als het mail-label)', () => {
    assert.equal(parseOmgeving(undefined), 'productie');
    assert.equal(parseOmgeving(''), 'productie');
    assert.equal(parseOmgeving('  '), 'productie');
  });

  it('elke andere waarde is een configuratiefout (A05), zonder de waarde zelf in de melding', () => {
    for (const v of ['acc', 'Acceptatie', 'production', 'test', 'acceptatie\nX-Injected: 1', '<script>']) {
      assert.throws(() => parseOmgeving(v), (e: unknown) => {
        assert.ok(e instanceof InvalidOmgevingError);
        assert.doesNotMatch((e as Error).message, /script|Injected|Acceptatie/);
        return true;
      }, `"${v}" had geweigerd moeten worden`);
    }
  });

  it('omgevingVoorWeb: in productie geen veld, anders de omgeving', () => {
    assert.deepEqual(omgevingVoorWeb('productie'), {});
    assert.deepEqual(omgevingVoorWeb('acceptatie'), { omgeving: 'acceptatie' });
    assert.deepEqual(omgevingVoorWeb('ontwikkeling'), { omgeving: 'ontwikkeling' });
  });
});

describe('DOEL-131: createApp weigert een ongeldige omgeving', () => {
  afterEach(restore);

  it('ongeldige DOELENBOOM_OMGEVING: de API start niet', () => {
    process.env.DOELENBOOM_OMGEVING = 'acceptatei';
    assert.throws(() => createApp(), InvalidOmgevingError);
  });

  it('geldige waarden starten gewoon', () => {
    for (const v of ['ontwikkeling', 'acceptatie', 'productie', '']) {
      process.env.DOELENBOOM_OMGEVING = v;
      assert.doesNotThrow(() => createApp());
    }
  });
});

describe('DOEL-131: GET /api/version geeft de omgeving buiten productie', () => {
  let server: Server;
  let base: string;
  before(async () => {
    delete process.env.DOELENBOOM_OMGEVING;
    server = createApp().listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    restore();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const version = async () => (await fetch(`${base}/api/version`)).json() as Promise<Record<string, unknown>>;

  it('acceptatie en ontwikkeling: veld "omgeving"', async () => {
    process.env.DOELENBOOM_OMGEVING = 'acceptatie';
    assert.equal((await version()).omgeving, 'acceptatie');
    process.env.DOELENBOOM_OMGEVING = 'ontwikkeling';
    assert.equal((await version()).omgeving, 'ontwikkeling');
  });

  it('productie (en niet gezet): geen veld "omgeving", versie en gitRef blijven', async () => {
    for (const v of ['productie', undefined]) {
      if (v === undefined) delete process.env.DOELENBOOM_OMGEVING;
      else process.env.DOELENBOOM_OMGEVING = v;
      const body = await version();
      assert.ok(!('omgeving' in body), JSON.stringify(body));
      assert.ok('version' in body && 'gitRef' in body);
    }
  });
});

describe('DOEL-131: de compose-bestanden zetten elk een geldige omgeving', () => {
  const omgevingIn = (file: string) => {
    const m = readFileSync(path.join(repo, file), 'utf8').match(/DOELENBOOM_OMGEVING:\s*(\S+)/);
    assert.ok(m, `${file} zet DOELENBOOM_OMGEVING niet`);
    return m[1];
  };
  it('ontwikkeling, acceptatie, productie', () => {
    assert.equal(omgevingIn('docker-compose.yml'), 'ontwikkeling');
    assert.equal(omgevingIn('docker-compose.acc.yml'), 'acceptatie');
    assert.equal(omgevingIn('docker-compose.prod.yml'), 'productie');
  });
});

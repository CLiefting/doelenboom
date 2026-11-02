// Regressietests voor DOEL-133: de lokale KLUIS-omgeving voor doelenbomen met
// gevoelige(re) informatie.
//
// 1. Zonder database: de omgeving "kluis" bestaat, heet in mails "[VAULT]",
//    geeft zich door aan de web-app (rode driehoek) en zet "GEVOELIG_" voor
//    bestandsnamen.
// 2. Met database en excel-service (anders overgeslagen, zoals
//    importsExports.test.ts): een Excel-export uit de kluis heet "GEVOELIG_…"
//    en draagt het kenmerk; in de kluis is hij weer in te lezen, elders wordt
//    hij geweigerd zonder dat er iets wordt opgeslagen.
//
// Op de oude code falen deze tests: "kluis" was een ongeldige omgeving (de API
// startte niet), er was geen kenmerk en elke omgeving las elk bestand in.
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, rawReq, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom, getBaseUrl,
} from './helpers.js';
import { pool } from '../src/db.js';
import { environmentLabel, labelSubject } from '../src/email.js';
import {
  gevoeligeBestandsnaam, GEVOELIG_GEWEIGERD, isGevoeligeOmgeving, omgevingVoorWeb, parseOmgeving,
} from '../src/omgeving.js';

const saved = process.env.DOELENBOOM_OMGEVING;
const restore = () => {
  if (saved === undefined) delete process.env.DOELENBOOM_OMGEVING;
  else process.env.DOELENBOOM_OMGEVING = saved;
};

describe('DOEL-133: omgeving "kluis" (zonder database)', () => {
  it('is een geldige omgeving en gaat naar de web-app (rode VAULT-driehoek)', () => {
    assert.equal(parseOmgeving('kluis'), 'kluis');
    assert.deepEqual(omgevingVoorWeb('kluis'), { omgeving: 'kluis' });
  });

  it('alleen de kluis is gevoelig', () => {
    assert.equal(isGevoeligeOmgeving('kluis'), true);
    for (const o of ['productie', 'acceptatie', 'ontwikkeling'] as const) assert.equal(isGevoeligeOmgeving(o), false);
  });

  it('bestandsnamen uit de kluis beginnen met GEVOELIG_, elders niet', () => {
    assert.equal(gevoeligeBestandsnaam('Doelenboom_T_B_261102.xlsx', 'kluis'), 'GEVOELIG_Doelenboom_T_B_261102.xlsx');
    assert.equal(gevoeligeBestandsnaam('Doelenboom_T_B_261102.xlsx', 'productie'), 'Doelenboom_T_B_261102.xlsx');
  });

  it('mails uit de kluis krijgen "[VAULT]" in het onderwerp', () => {
    assert.equal(environmentLabel('kluis'), '[VAULT] ');
    assert.equal(labelSubject('Je Doelenboom-inlogcode', 'kluis'), '[VAULT] Je Doelenboom-inlogcode');
  });
});

const PREFIX = unique('kluis');
const EXCEL_SERVICE_URL = process.env.EXCEL_SERVICE_URL ?? 'http://localhost:8000';
let excelServiceReachable = false;

describe('DOEL-133: Excel uit de kluis alleen in de kluis inlezen (database + excel-service)', () => {
  let doelenboomId: number;
  let adminToken: string;

  before(async () => {
    await startTestServer();
    try {
      excelServiceReachable = (await fetch(`${EXCEL_SERVICE_URL}/health`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      excelServiceReachable = false;
    }
    const email = `${PREFIX}-sysadmin@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    const sysadminToken = await login(email, 'wachtwoord123');
    let tenantId: number;
    ({ doelenboomId, tenantId, adminToken } = await setupWritableDoelenboom(sysadminToken, PREFIX));
    // Voor de project-Excel: module Projecten aan en één Project-element.
    await req('PUT', `/api/tenants/${tenantId}/license/modules/projecten`, { token: sysadminToken, body: { active: true } });
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: adminToken, body: { code: 'KP1', type: 'Project', name: 'Kluisproject' },
    });
  });

  afterEach(restore);

  after(async () => {
    restore();
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  const exportXlsx = async () => {
    const res = await rawReq('GET', `/api/doelenbomen/${doelenboomId}/export?format=nieuw&mode=data`, { token: adminToken });
    assert.equal(res.status, 200);
    return { disposition: res.headers.get('content-disposition') ?? '', bytes: new Uint8Array(await res.arrayBuffer()) };
  };
  const upload = async (bytes: Uint8Array) => {
    const form = new FormData();
    form.append('file', new Blob([bytes]), 'upload.xlsx');
    const res = await fetch(`${getBaseUrl()}/api/doelenbomen/${doelenboomId}/imports`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: form,
    });
    return { status: res.status, body: (await res.json()) as { error?: string; id?: number } };
  };
  const importCount = async () =>
    Number((await pool.query('select count(*) from excel_imports where doelenboom_id = $1', [doelenboomId])).rows[0].count);

  it('export uit de kluis: bestandsnaam GEVOELIG_…; in de kluis weer in te lezen', async (t) => {
    if (!excelServiceReachable) return t.skip('excel-service niet bereikbaar — zie EXCEL_SERVICE_URL');
    process.env.DOELENBOOM_OMGEVING = 'kluis';
    const { disposition, bytes } = await exportXlsx();
    assert.match(disposition, /filename="GEVOELIG_Doelenboom_/);
    const res = await upload(bytes);
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  it('hetzelfde bestand in productie, acceptatie of ontwikkeling: 409 en niets opgeslagen', async (t) => {
    if (!excelServiceReachable) return t.skip('excel-service niet bereikbaar — zie EXCEL_SERVICE_URL');
    process.env.DOELENBOOM_OMGEVING = 'kluis';
    const { bytes } = await exportXlsx();
    for (const elders of ['productie', 'acceptatie', 'ontwikkeling', '']) {
      process.env.DOELENBOOM_OMGEVING = elders;
      const before = await importCount();
      const res = await upload(bytes);
      assert.equal(res.status, 409, `${elders || 'leeg'}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, GEVOELIG_GEWEIGERD);
      assert.equal(await importCount(), before, `${elders || 'leeg'}: er is toch een import opgeslagen`);
    }
  });

  it('een gewone export (niet uit de kluis) blijft overal gewoon in te lezen', async (t) => {
    if (!excelServiceReachable) return t.skip('excel-service niet bereikbaar — zie EXCEL_SERVICE_URL');
    delete process.env.DOELENBOOM_OMGEVING;
    const { disposition, bytes } = await exportXlsx();
    assert.doesNotMatch(disposition, /GEVOELIG_/);
    assert.equal((await upload(bytes)).status, 201);
  });

  it('project-Excel uit de kluis: GEVOELIG_…; project-import elders 409, in de kluis gewoon', async (t) => {
    if (!excelServiceReachable) return t.skip('excel-service niet bereikbaar — zie EXCEL_SERVICE_URL');
    process.env.DOELENBOOM_OMGEVING = 'kluis';
    const exp = await rawReq('GET', `/api/doelenbomen/${doelenboomId}/elements/KP1/project-export`, { token: adminToken });
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get('content-disposition') ?? '', /filename="GEVOELIG_Project_KP1_/);
    const bytes = new Uint8Array(await exp.arrayBuffer());
    const parse = async () => {
      const form = new FormData();
      form.append('file', new Blob([bytes]), 'project.xlsx');
      const res = await fetch(`${getBaseUrl()}/api/doelenbomen/${doelenboomId}/elements/KP1/project-import-parse`, {
        method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: form,
      });
      return { status: res.status, body: (await res.json()) as { error?: string } };
    };
    assert.equal((await parse()).status, 200);
    process.env.DOELENBOOM_OMGEVING = 'productie';
    const refused = await parse();
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, GEVOELIG_GEWEIGERD);
  });
});


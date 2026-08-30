import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';

const PREFIX = unique('sub');

// Zelfbedieningsaanvraag voor een nieuw abonnement — zie
// doelenboom_licentiemodel.md §2/§9, api/src/subscriptions.ts,
// api/src/offers.ts en api/src/routes/subscriptions.ts. Dekt de volledige
// levenscyclus (aanvragen -> proef -> betaling -> actief -> verlengen /
// afwijzen), de aanbiedingen-catalogus, de licentie-events-logging (aparte
// traceerbaarheid-eis uit het interview) en de doelenbomen.ts-fix die
// voorkwam dat een tenant met verlopen licentie toch nog nieuwe doelenbomen
// kon aanmaken.
describe('zelfbedieningsaanvraag', () => {
  let sysadminToken: string;
  const sysadminEmail = `${PREFIX}-admin@test.local`;

  before(async () => {
    await startTestServer();
    await createSysadminUser(sysadminEmail, 'wachtwoord123');
    sysadminToken = await login(sysadminEmail, 'wachtwoord123');
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  // --- Helpers: een tier met een op dit moment geldige prijs, en datumrekenkunde ---

  function today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  function addDaysStr(dateStr: string, days: number): string {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function lastDayOfMonth(year: number, month1to12: number): number {
    return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
  }

  // Maakt een tier aan én, tenzij priceEur null is, een direct geldige
  // prijsperiode ervoor (via de losse prijsgeschiedenis-endpoints — een tier
  // heeft zelf geen prijsveld meer, zie api/src/tierPrices.ts).
  async function makeTier(namePrefix: string, priceEur: number | null, validFrom?: string, validUntil?: string) {
    const r = await req('POST', '/api/tiers', {
      token: sysadminToken,
      body: { name: `${PREFIX}-${namePrefix}`, maxAdmins: 5, maxBomen: 20, sortOrder: 0 },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const tier = r.body;
    if (priceEur != null) {
      const priceR = await req('POST', `/api/tiers/${tier.id}/prices`, {
        token: sysadminToken,
        body: {
          priceEur,
          validFrom: validFrom ?? addDaysStr(today(), -30),
          validUntil: validUntil ?? addDaysStr(today(), 30),
        },
      });
      assert.equal(priceR.status, 201, JSON.stringify(priceR.body));
    }
    return tier;
  }

  async function makeOffer(body: Record<string, unknown>) {
    const r = await req('POST', '/api/offers', { token: sysadminToken, body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  }

  describe('publieke aanvraagpagina (ongeauthenticeerd)', () => {
    it('GET /api/subscription-tiers toont alleen tiers met een op dit moment geldige prijs', async () => {
      const geldig = await makeTier('geldig1', 500);
      const verlopen = await makeTier('verlopen1', 500, addDaysStr(today(), -60), addDaysStr(today(), -1));
      const zonderPrijs = await req('POST', '/api/tiers', {
        token: sysadminToken, body: { name: `${PREFIX}-zonderprijs1`, maxAdmins: 1, maxBomen: 1, sortOrder: 0 },
      });

      const anon = await req('GET', '/api/subscription-tiers');
      assert.equal(anon.status, 200);
      const ids = anon.body.map((t: any) => String(t.id));
      assert.ok(ids.includes(String(geldig.id)));
      assert.ok(!ids.includes(String(verlopen.id)), 'tier met verlopen prijsperiode hoort niet in de publieke lijst');
      assert.ok(!ids.includes(String(zonderPrijs.body.id)), 'tier zonder prijs hoort niet in de publieke lijst');
    });

    it('GET /api/subscription-modules en /api/subscription-offers werken zonder token', async () => {
      const modules = await req('GET', '/api/subscription-modules');
      assert.equal(modules.status, 200);
      assert.ok(modules.body.some((m: any) => m.key === 'projecten'));

      const offers = await req('GET', '/api/subscription-offers');
      assert.equal(offers.status, 200);
      assert.ok(Array.isArray(offers.body));
    });

    it('GET /api/subscription-tiers/:id/price berekent het effectieve tarief inclusief lopende aanbieding', async () => {
      const tier = await makeTier('prijsquote', 1000);
      const offer = await makeOffer({
        name: `${PREFIX}-33pct`, kind: 'percentage', value: 33,
        validFrom: addDaysStr(today(), -1), validUntil: addDaysStr(today(), 1), tierIds: [tier.id],
      });

      const quote = await req('GET', `/api/subscription-tiers/${tier.id}/price`);
      assert.equal(quote.status, 200);
      assert.equal(Number(quote.body.tierPriceEur), 1000);
      assert.equal(quote.body.offer.id, offer.id);
      assert.equal(Number(quote.body.finalPriceEur), 670);
      assert.equal(quote.body.btwVrij, false);

      const missing = await req('GET', '/api/subscription-tiers/999999999/price');
      assert.equal(missing.status, 404);
    });

    it('module-opslagpercentages tellen mee in de aanvraagprijs (subtotaal vóór aanbieding)', async () => {
      const tier = await makeTier('metmodule', 1000);
      const modR = await req('POST', '/api/modules', {
        token: sysadminToken, body: { key: `${PREFIX}-opslagmodule`, name: 'Opslagmodule test' },
      });
      assert.equal(modR.status, 201, JSON.stringify(modR.body));
      const mod = modR.body;
      const surchargeR = await req('POST', `/api/modules/${mod.id}/surcharges`, {
        token: sysadminToken,
        body: { surchargePct: 20, validFrom: addDaysStr(today(), -30), validUntil: addDaysStr(today(), 30) },
      });
      assert.equal(surchargeR.status, 201, JSON.stringify(surchargeR.body));

      // Zonder de module geselecteerd: alleen de tierprijs.
      const zonderModule = await req('GET', `/api/subscription-tiers/${tier.id}/price`);
      assert.equal(Number(zonderModule.body.tierPriceEur), 1000);
      assert.deepEqual(zonderModule.body.moduleSurcharges, []);
      assert.equal(Number(zonderModule.body.subtotalEur), 1000);
      assert.equal(Number(zonderModule.body.finalPriceEur), 1000);

      // Met de module: 20% opslag over de tierprijs (€ 200) komt bovenop.
      const metModule = await req('GET', `/api/subscription-tiers/${tier.id}/price?modules=${mod.key}`);
      assert.equal(metModule.status, 200);
      assert.equal(metModule.body.moduleSurcharges.length, 1);
      assert.equal(metModule.body.moduleSurcharges[0].moduleKey, mod.key);
      assert.equal(Number(metModule.body.moduleSurcharges[0].amountEur), 200);
      assert.equal(Number(metModule.body.subtotalEur), 1200);
      assert.equal(Number(metModule.body.finalPriceEur), 1200);

      // En dat subtotaal (tier + opslag) telt ook mee als basis voor de
      // gesnapshotte prijs van een echte aanvraag.
      const email = `${PREFIX}-metmodule@test.local`;
      const created = await req('POST', '/api/subscription-requests', {
        body: {
          organizationName: `${PREFIX} MetModule`, applicantName: 'X', applicantEmail: email,
          password: 'wachtwoord123', tierId: tier.id, moduleKeys: [mod.key],
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const list = await req('GET', '/api/subscription-requests', { token: sysadminToken });
      const row = list.body.find((r: any) => r.requestId === created.body.requestId || r.id === created.body.requestId);
      assert.equal(Number(row.priceAtRequest), 1200);
    });

    it('een BTW-vrij-aanbieding laat de prijs ongewijzigd maar zet btwVrij op true', async () => {
      const tier = await makeTier('btwvrij', 800);
      await makeOffer({
        name: `${PREFIX}-btwvrij-offer`, kind: 'btw_vrij', value: null,
        validFrom: addDaysStr(today(), -1), validUntil: addDaysStr(today(), 1), tierIds: [tier.id],
      });

      const quote = await req('GET', `/api/subscription-tiers/${tier.id}/price`);
      assert.equal(Number(quote.body.finalPriceEur), 800);
      assert.equal(quote.body.btwVrij, true);
    });

    it('POST /api/subscription-requests valideert invoer', async () => {
      const tier = await makeTier('validatie', 250);
      const empty = await req('POST', '/api/subscription-requests', { body: {} });
      assert.equal(empty.status, 400);

      const badEmail = await req('POST', '/api/subscription-requests', {
        body: {
          organizationName: 'Test BV', applicantName: 'Jan', applicantEmail: 'niet-geldig',
          password: 'wachtwoord123', tierId: tier.id, moduleKeys: [],
        },
      });
      assert.equal(badEmail.status, 400);

      const kortWachtwoord = await req('POST', '/api/subscription-requests', {
        body: {
          organizationName: 'Test BV', applicantName: 'Jan', applicantEmail: `${PREFIX}-kort@test.local`,
          password: 'kort', tierId: tier.id, moduleKeys: [],
        },
      });
      assert.equal(kortWachtwoord.status, 400);

      const onbekendeTier = await req('POST', '/api/subscription-requests', {
        body: {
          organizationName: 'Test BV', applicantName: 'Jan', applicantEmail: `${PREFIX}-tier@test.local`,
          password: 'wachtwoord123', tierId: 999999999, moduleKeys: [],
        },
      });
      assert.equal(onbekendeTier.status, 400);
      assert.match(onbekendeTier.body.error, /Onbekende tier/);

      const onbekendeModule = await req('POST', '/api/subscription-requests', {
        body: {
          organizationName: 'Test BV', applicantName: 'Jan', applicantEmail: `${PREFIX}-mod@test.local`,
          password: 'wachtwoord123', tierId: tier.id, moduleKeys: ['bestaat-niet-echt'],
        },
      });
      assert.equal(onbekendeModule.status, 400);
      assert.match(onbekendeModule.body.error, /modules bestaan niet/);
    });

    it('een geslaagde aanvraag maakt tenant + proefaccount (14 dagen) + snapshot van de prijs, en logt "aangevraagd"', async () => {
      const tier = await makeTier('geslaagd', 500);
      const offer = await makeOffer({
        name: `${PREFIX}-geslaagd-offer`, kind: 'fixed_amount', value: 50,
        validFrom: addDaysStr(today(), -1), validUntil: addDaysStr(today(), 1), tierIds: [tier.id],
      });

      const email = `${PREFIX}-nieuw@test.local`;
      const created = await req('POST', '/api/subscription-requests', {
        body: {
          organizationName: `${PREFIX} Organisatie`, applicantName: 'Nieuwe Aanvrager', applicantEmail: email,
          password: 'wachtwoord123', tierId: tier.id, moduleKeys: ['projecten'],
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.ok(created.body.tenantId);
      assert.ok(created.body.requestId);

      // Duplicaat e-mailadres is een 400.
      const dup = await req('POST', '/api/subscription-requests', {
        body: {
          organizationName: 'Nog een keer', applicantName: 'Iemand', applicantEmail: email,
          password: 'wachtwoord123', tierId: tier.id, moduleKeys: [],
        },
      });
      assert.equal(dup.status, 400);
      assert.match(dup.body.error, /bestaat al/);

      // Proefaccount werkt meteen (zelfgekozen wachtwoord, geen
      // must_change_password) en kan lezen (bv. GET /api/doelenbomen) — de
      // licentie is nog niet verlopen (14 dagen proef).
      const applicantToken = await login(email, 'wachtwoord123');
      const doelenbomen = await req('GET', '/api/doelenbomen', { token: applicantToken });
      assert.equal(doelenbomen.status, 200);
      assert.deepEqual(doelenbomen.body, []);

      // Sysadmin-only overzicht toont de aanvraag met status 'proef' en de
      // gesnapshotte (verdisconteerde) prijs. De verwachte prijs wordt via
      // dezelfde price-quote-endpoint opgevraagd i.p.v. hardgecodeerd, zodat
      // deze test niet breekt op het (elders al gedekte) opslagpercentage van
      // de "projecten"-module, dat zelf ook een eigen, tijdgebonden waarde heeft.
      const expectedQuote = await req('GET', `/api/subscription-tiers/${tier.id}/price?modules=projecten`);
      assert.equal(expectedQuote.status, 200);

      const list = await req('GET', '/api/subscription-requests', { token: sysadminToken });
      const row = list.body.find((r: any) => r.requestId === created.body.requestId || r.id === created.body.requestId);
      assert.ok(row, 'aanvraag moet in het sysadmin-overzicht staan');
      assert.equal(row.status, 'proef');
      assert.equal(
        Number(row.priceAtRequest), Number(expectedQuote.body.finalPriceEur),
        'gesnapshotte prijs moet de € 50 vaste korting (en evt. module-opslag) al verdisconteren'
      );
      assert.equal(row.licenseEndDate, addDaysStr(today(), 14), 'proefperiode is 14 dagen vanaf aanvraagdatum');

      // Aparte logging-module: de aanvraag zelf is gelogd, zonder performedBy
      // (publieke actie, geen ingelogde gebruiker).
      const events = await req('GET', `/api/subscription-requests/${row.id}/events`, { token: sysadminToken });
      assert.equal(events.status, 200);
      const aangevraagd = events.body.find((e: any) => e.eventType === 'aangevraagd');
      assert.ok(aangevraagd, 'er moet een "aangevraagd"-event gelogd zijn');
      assert.equal(aangevraagd.performedByEmail, null);
      assert.equal(aangevraagd.detail.offerId, offer.id);

      void offer;
    });

    it('sysadmin-beheerroutes zijn niet publiek toegankelijk en niet voor gewone tenant-admins', async () => {
      const anon = await req('GET', '/api/subscription-requests');
      assert.equal(anon.status, 401);

      // Maak een gewone (niet-sysadmin) tenant-admin via een eigen aanvraag.
      const tier = await makeTier('nietsysadmin', 300);
      const email = `${PREFIX}-nietsysadmin@test.local`;
      await req('POST', '/api/subscription-requests', {
        body: {
          organizationName: `${PREFIX} NietSysadmin`, applicantName: 'X', applicantEmail: email,
          password: 'wachtwoord123', tierId: tier.id, moduleKeys: [],
        },
      });
      const tenantAdminToken = await login(email, 'wachtwoord123');
      const asTenantAdmin = await req('GET', '/api/subscription-requests', { token: tenantAdminToken });
      assert.equal(asTenantAdmin.status, 403);
    });
  });

  describe('sysadmin-beheer: betaling, verlenging, afwijzen', () => {
    async function makeTrialRequest(prefix: string, tierPrice = 500) {
      const tier = await makeTier(prefix, tierPrice);
      const email = `${PREFIX}-${prefix}@test.local`;
      const created = await req('POST', '/api/subscription-requests', {
        body: {
          organizationName: `${PREFIX}-${prefix} Org`, applicantName: 'Aanvrager', applicantEmail: email,
          password: 'wachtwoord123', tierId: tier.id, moduleKeys: [],
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      return { requestId: created.body.requestId as number, tenantId: created.body.tenantId as number, email };
    }

    it('betaling registreren zet "proef" -> "actief", berekent contract- en licentie-einddatum, en logt het event', async () => {
      const { requestId } = await makeTrialRequest('betaling1');

      const anon = await req('POST', `/api/subscription-requests/${requestId}/register-payment`, {});
      assert.equal(anon.status, 401);

      const result = await req('POST', `/api/subscription-requests/${requestId}/register-payment`, { token: sysadminToken });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.status, 'actief');
      assert.ok(result.body.contractEndDate);
      assert.ok(result.body.licenseEndDate);

      // Contractuele einddatum = laatste dag van de maand van de aanvraagdatum
      // (vandaag, in deze test), +12 maanden — zie doelenboom_licentiemodel.md
      // §6/license.ts computeDefaultLicenseEndDate.
      const now = new Date();
      const [cy, cm, cd] = result.body.contractEndDate.split('-').map(Number);
      assert.equal(cy, now.getUTCFullYear() + 1);
      assert.equal(cm, now.getUTCMonth() + 1);
      assert.equal(cd, lastDayOfMonth(now.getUTCFullYear(), now.getUTCMonth() + 1));

      // Licentie-einddatum (de daadwerkelijke handhavingsdatum) = contractuele
      // einddatum + 30 dagen coulance.
      assert.equal(result.body.licenseEndDate, addDaysStr(result.body.contractEndDate, 30));

      // Nogmaals proberen (niet meer op 'proef') geeft een duidelijke 409.
      const again = await req('POST', `/api/subscription-requests/${requestId}/register-payment`, { token: sysadminToken });
      assert.equal(again.status, 409);

      const events = await req('GET', `/api/subscription-requests/${requestId}/events`, { token: sysadminToken });
      const betaling = events.body.find((e: any) => e.eventType === 'betaling_geregistreerd');
      assert.ok(betaling);
      assert.equal(betaling.performedByEmail, sysadminEmail);
    });

    it('verlenging schuift de contractuele einddatum exact 12 maanden op (regressietest voor de maand-opschuif-bug)', async () => {
      const { requestId } = await makeTrialRequest('verleng1');
      const payment = await req('POST', `/api/subscription-requests/${requestId}/register-payment`, { token: sysadminToken });
      const contractEndDate = payment.body.contractEndDate as string;

      // Vóór er een contract_end_date is (nog op 'proef') kan er niet verlengd worden.
      const { requestId: proefId } = await makeTrialRequest('verleng-proef');
      const geenContract = await req('POST', `/api/subscription-requests/${proefId}/register-renewal`, { token: sysadminToken });
      assert.equal(geenContract.status, 409);

      const renewal = await req('POST', `/api/subscription-requests/${requestId}/register-renewal`, { token: sysadminToken });
      assert.equal(renewal.status, 200, JSON.stringify(renewal.body));
      const newContractEndDate = renewal.body.contractEndDate as string;

      const [y1, m1, d1] = contractEndDate.split('-').map(Number);
      const [y2, m2, d2] = newContractEndDate.split('-').map(Number);
      // Vóór de fix schoof dit een maand op (omdat er intern "dag erna" werd
      // doorgegeven aan computeDefaultLicenseEndDate i.p.v. de datum zelf) —
      // bv. 2027-08-31 werd dan foutief 2028-09-30 i.p.v. 2028-08-31.
      assert.equal(m2, m1, 'maand moet exact gelijk blijven bij verlengen');
      assert.equal(y2, y1 + 1, 'jaar moet precies 1 opschuiven bij verlengen');
      assert.equal(d2, d1, 'dag moet gelijk blijven (beide zijn al "laatste dag van de maand")');

      assert.equal(renewal.body.licenseEndDate, addDaysStr(newContractEndDate, 30));

      const events = await req('GET', `/api/subscription-requests/${requestId}/events`, { token: sysadminToken });
      const verlengd = events.body.find((e: any) => e.eventType === 'verlengd');
      assert.ok(verlengd);
      assert.equal(verlengd.detail.previousContractEndDate, contractEndDate);
      assert.equal(verlengd.performedByEmail, sysadminEmail);
    });

    it('afwijzen vereist een reden, blokkeert de tenant onmiddellijk (schrijven dicht, lezen blijft open), en logt het event', async () => {
      const { requestId, tenantId, email } = await makeTrialRequest('afwijzen1');

      const zonderReden = await req('POST', `/api/subscription-requests/${requestId}/reject`, { token: sysadminToken, body: {} });
      assert.equal(zonderReden.status, 400);

      const rejected = await req('POST', `/api/subscription-requests/${requestId}/reject`, {
        token: sysadminToken, body: { reason: 'Onvolledige gegevens' },
      });
      assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
      assert.equal(rejected.body.status, 'afgewezen');
      assert.equal(rejected.body.rejectedReason, 'Onvolledige gegevens');
      assert.equal(rejected.body.licenseEndDate, addDaysStr(today(), -1), 'blokkade moet meteen ingaan (gisteren)');

      // Nogmaals afwijzen (niet meer op 'proef') geeft 409.
      const again = await req('POST', `/api/subscription-requests/${requestId}/reject`, {
        token: sysadminToken, body: { reason: 'nogmaals' },
      });
      assert.equal(again.status, 409);

      // Lezen blijft mogelijk (alleen-lezen, geen volledige lockout).
      const applicantToken = await login(email, 'wachtwoord123');
      const lezen = await req('GET', '/api/doelenbomen', { token: applicantToken });
      assert.equal(lezen.status, 200);

      // Maar een nieuwe doelenboom aanmaken is geblokkeerd (de doelenbomen.ts-
      // fix: zonder deze check kon een afgewezen/verlopen tenant alsnog een
      // gloednieuwe doelenboom aanmaken).
      const geblokkeerd = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
        token: applicantToken, body: { slug: 'nieuweboom', name: 'Nieuwe boom' },
      });
      assert.equal(geblokkeerd.status, 403);
      assert.match(geblokkeerd.body.error, /licentie.*verlopen/i);

      const events = await req('GET', `/api/subscription-requests/${requestId}/events`, { token: sysadminToken });
      const afgewezen = events.body.find((e: any) => e.eventType === 'afgewezen');
      assert.ok(afgewezen);
      assert.equal(afgewezen.detail.reason, 'Onvolledige gegevens');
      assert.equal(afgewezen.performedByEmail, sysadminEmail);
    });

    it('pending-count en upcoming-renewals geven de juiste tellingen/lijst terug', async () => {
      const { requestId: proefId } = await makeTrialRequest('tellen-proef');
      const { requestId: actiefId } = await makeTrialRequest('tellen-actief');
      await req('POST', `/api/subscription-requests/${actiefId}/register-payment`, { token: sysadminToken });

      const counts = await req('GET', '/api/subscription-requests/pending-count', { token: sysadminToken });
      assert.equal(counts.status, 200);
      assert.ok(counts.body.pendingRequests >= 1);

      // withinDays=9999 zodat de zojuist geregistreerde 12-maanden-out
      // verlenging (ver in de toekomst) toch als "aanstaand" meetelt in de test.
      const renewals = await req('GET', '/api/subscription-requests/upcoming-renewals?withinDays=9999', { token: sysadminToken });
      assert.equal(renewals.status, 200);
      const ids = renewals.body.map((r: any) => r.id);
      assert.ok(ids.includes(actiefId));
      assert.ok(!ids.includes(proefId), 'een aanvraag die nog op proef staat telt niet als "verlenging"');
    });
  });

  describe('aanbiedingen (offers) — CRUD en validatie', () => {
    it('validatie: naam/kind/datums/value/percentage-grens', async () => {
      const tier = await makeTier('offervalidatie', 400);

      const geenNaam = await req('POST', '/api/offers', {
        token: sysadminToken, body: { kind: 'percentage', value: 10, validFrom: today(), validUntil: today(), tierIds: [tier.id] },
      });
      assert.equal(geenNaam.status, 400);

      const fouteKind = await req('POST', '/api/offers', {
        token: sysadminToken, body: { name: 'x', kind: 'onzin', value: 10, validFrom: today(), validUntil: today(), tierIds: [] },
      });
      assert.equal(fouteKind.status, 400);

      const foutePeriode = await req('POST', '/api/offers', {
        token: sysadminToken,
        body: { name: 'x', kind: 'percentage', value: 10, validFrom: today(), validUntil: addDaysStr(today(), -5), tierIds: [] },
      });
      assert.equal(foutePeriode.status, 400);

      const geenValue = await req('POST', '/api/offers', {
        token: sysadminToken, body: { name: 'x', kind: 'percentage', validFrom: today(), validUntil: today(), tierIds: [] },
      });
      assert.equal(geenValue.status, 400);

      const teHoogPercentage = await req('POST', '/api/offers', {
        token: sysadminToken,
        body: { name: 'x', kind: 'percentage', value: 150, validFrom: today(), validUntil: today(), tierIds: [] },
      });
      assert.equal(teHoogPercentage.status, 400);

      const btwVrijZonderValue = await req('POST', '/api/offers', {
        token: sysadminToken,
        body: { name: 'x', kind: 'btw_vrij', validFrom: today(), validUntil: today(), tierIds: [tier.id] },
      });
      assert.equal(btwVrijZonderValue.status, 201, 'btw_vrij heeft geen value nodig');
    });

    it('aanmaken/bewerken/verwijderen is sysadmin-only', async () => {
      const tier = await makeTier('offersysadminonly', 300);
      const email = `${PREFIX}-offer-tenantadmin@test.local`;
      await req('POST', '/api/subscription-requests', {
        body: {
          organizationName: `${PREFIX} OfferTenantAdmin`, applicantName: 'X', applicantEmail: email,
          password: 'wachtwoord123', tierId: tier.id, moduleKeys: [],
        },
      });
      const tenantAdminToken = await login(email, 'wachtwoord123');

      const asTenantAdmin = await req('POST', '/api/offers', {
        token: tenantAdminToken,
        body: { name: 'poging', kind: 'percentage', value: 10, validFrom: today(), validUntil: today(), tierIds: [] },
      });
      assert.equal(asTenantAdmin.status, 403);
    });

    it('CRUD: aanmaken, bewerken (incl. tier-koppeling), verwijderen', async () => {
      const tierA = await makeTier('offercrudA', 300);
      const tierB = await makeTier('offercrudB', 600);

      const created = await makeOffer({
        name: `${PREFIX}-crud-offer`, kind: 'percentage', value: 10,
        validFrom: today(), validUntil: addDaysStr(today(), 10), tierIds: [tierA.id],
      });
      assert.deepEqual(created.tierIds, [tierA.id]);

      const updated = await req('PUT', `/api/offers/${created.id}`, {
        token: sysadminToken,
        body: {
          name: `${PREFIX}-crud-offer-gewijzigd`, kind: 'fixed_amount', value: 25,
          validFrom: today(), validUntil: addDaysStr(today(), 20), tierIds: [tierA.id, tierB.id],
        },
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.name, `${PREFIX}-crud-offer-gewijzigd`);
      assert.equal(updated.body.kind, 'fixed_amount');
      assert.deepEqual([...updated.body.tierIds].sort(), [tierA.id, tierB.id].sort());

      const list = await req('GET', '/api/offers', { token: sysadminToken });
      assert.ok(list.body.some((o: any) => o.id === created.id));

      const deleted = await req('DELETE', `/api/offers/${created.id}`, { token: sysadminToken });
      assert.equal(deleted.status, 204);
      const missing = await req('PUT', `/api/offers/${created.id}`, {
        token: sysadminToken,
        body: { name: 'weg', kind: 'percentage', value: 5, validFrom: today(), validUntil: today(), tierIds: [] },
      });
      assert.equal(missing.status, 404);
    });
  });

  // "Evaluatie"-achtige tiers (zie db/migrations/0018_evaluatie_tier.sql en
  // Charles' verzoek van 30 augustus 2026: 1 admin, 2 bomen, 30 dagen proef,
  // alle modules automatisch aan, gratis). trialDays/allModulesIncluded zijn
  // generieke tier-velden (geen hardgecodeerde uitzondering op tiernaam), dus
  // deze tests zetten zelf een eigen tier met die velden op i.p.v. te
  // vertrouwen op de seed-rij "Evaluatie".
  describe('tiers met trialDays/allModulesIncluded (generalisatie voor "gratis proeftier"-tiers)', () => {
    async function makeEvaluatieAchtigeTier(namePrefix: string, opts: { trialDays?: number | null; allModulesIncluded?: boolean; priceEur?: number } = {}) {
      const r = await req('POST', '/api/tiers', {
        token: sysadminToken,
        body: {
          name: `${PREFIX}-${namePrefix}`, maxAdmins: 1, maxBomen: 2, sortOrder: -1,
          trialDays: opts.trialDays ?? 30, allModulesIncluded: opts.allModulesIncluded ?? true,
        },
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const tier = r.body;
      const priceEur = opts.priceEur ?? 0;
      const priceR = await req('POST', `/api/tiers/${tier.id}/prices`, {
        token: sysadminToken,
        body: { priceEur, validFrom: addDaysStr(today(), -30), validUntil: addDaysStr(today(), 30) },
      });
      assert.equal(priceR.status, 201, JSON.stringify(priceR.body));
      return tier;
    }

    it('POST /api/tiers accepteert trialDays/allModulesIncluded en geeft ze terug', async () => {
      const tier = await makeEvaluatieAchtigeTier('velden', { trialDays: 30, allModulesIncluded: true });
      assert.equal(tier.trialDays, 30);
      assert.equal(tier.allModulesIncluded, true);

      // Standaard (geen van beide meegegeven): trialDays null, allModulesIncluded false.
      const standaard = await req('POST', '/api/tiers', {
        token: sysadminToken,
        body: { name: `${PREFIX}-standaardtier`, maxAdmins: 3, maxBomen: 8, sortOrder: 0 },
      });
      assert.equal(standaard.status, 201, JSON.stringify(standaard.body));
      assert.equal(standaard.body.trialDays, null);
      assert.equal(standaard.body.allModulesIncluded, false);
    });

    it('PUT /api/tiers/:id kan trialDays expliciet terugzetten naar null (standaardduur)', async () => {
      const tier = await makeEvaluatieAchtigeTier('resettrial', { trialDays: 45 });
      assert.equal(tier.trialDays, 45);

      const updated = await req('PUT', `/api/tiers/${tier.id}`, {
        token: sysadminToken, body: { trialDays: null },
      });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      assert.equal(updated.body.trialDays, null);
      // Andere velden (incl. allModulesIncluded) blijven ongewijzigd als ze niet meegegeven worden.
      assert.equal(updated.body.allModulesIncluded, true);
      assert.equal(updated.body.maxAdmins, 1);
    });

    it('een aanvraag op zo\'n tier krijgt de tier-specifieke proefduur i.p.v. de standaard 14 dagen', async () => {
      const tier = await makeEvaluatieAchtigeTier('proefduur', { trialDays: 30, allModulesIncluded: false });
      const email = `${PREFIX}-proefduur@test.local`;
      const created = await req('POST', '/api/subscription-requests', {
        body: {
          organizationName: `${PREFIX} Proefduur`, applicantName: 'X', applicantEmail: email,
          password: 'wachtwoord123', tierId: tier.id, moduleKeys: [],
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));

      const list = await req('GET', '/api/subscription-requests', { token: sysadminToken });
      const row = list.body.find((r: any) => r.requestId === created.body.requestId || r.id === created.body.requestId);
      assert.ok(row);
      assert.equal(row.licenseEndDate, addDaysStr(today(), 30), 'proefperiode moet de tier-specifieke 30 dagen zijn, niet de standaard 14');
    });

    it('allModulesIncluded activeert ALLE bestaande modules, ongeacht de aangevinkte moduleKeys, en de prijs is € 0 (gratis)', async () => {
      // Extra module aanmaken zodat er zeker meerdere modules bestaan (naast
      // de al bestaande "projecten") — allModulesIncluded moet ze ALLEBEI
      // activeren, ook al selecteert de aanvrager er zelf geen enkele.
      const extraModR = await req('POST', '/api/modules', {
        token: sysadminToken, body: { key: `${PREFIX}-extramodule`, name: 'Extra module test' },
      });
      assert.equal(extraModR.status, 201, JSON.stringify(extraModR.body));
      const extraMod = extraModR.body;

      const tier = await makeEvaluatieAchtigeTier('allemodules', { allModulesIncluded: true, priceEur: 0 });
      const allModules = await req('GET', '/api/modules', { token: sysadminToken });
      assert.ok(allModules.body.some((m: any) => m.key === extraMod.key));

      const email = `${PREFIX}-allemodules@test.local`;
      const created = await req('POST', '/api/subscription-requests', {
        body: {
          organizationName: `${PREFIX} AlleModules`, applicantName: 'X', applicantEmail: email,
          password: 'wachtwoord123', tierId: tier.id, moduleKeys: [], // bewust leeg — moet toch alles krijgen
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const tenantId = created.body.tenantId as number;

      const license = await req('GET', `/api/tenants/${tenantId}/license`, { token: sysadminToken });
      assert.equal(license.status, 200, JSON.stringify(license.body));
      const activeKeys: string[] = license.body.activeModules;
      const expectedKeys = allModules.body.map((m: any) => m.key);
      assert.deepEqual([...activeKeys].sort(), [...expectedKeys].sort(), 'alle op dat moment bestaande modules moeten actief zijn');

      // Prijs: € 0 (gratis) — ondanks dat er modules "geactiveerd" zijn, telt
      // er geen opslag mee omdat er voor deze test-modules geen surcharge is
      // ingesteld; de tier-basisprijs zelf is 0.
      const list = await req('GET', '/api/subscription-requests', { token: sysadminToken });
      const row = list.body.find((r: any) => r.requestId === created.body.requestId || r.id === created.body.requestId);
      assert.equal(Number(row.priceAtRequest), 0);
    });

    it('allModulesIncluded negeert ook een onbekende/ongeldige moduleKeys-waarde van de aanvrager', async () => {
      const tier = await makeEvaluatieAchtigeTier('onbekendemodules', { allModulesIncluded: true });
      const email = `${PREFIX}-onbekendemodules@test.local`;
      const created = await req('POST', '/api/subscription-requests', {
        body: {
          organizationName: `${PREFIX} OnbekendeModules`, applicantName: 'X', applicantEmail: email,
          password: 'wachtwoord123', tierId: tier.id, moduleKeys: ['bestaat-niet-echt'],
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body), 'allModulesIncluded moet de opgegeven (ongeldige) moduleKeys al overschreven hebben vóór de validatie');
    });

    it('regressie: een tier ZONDER trialDays/allModulesIncluded houdt de standaard 14-dagen-proef en alleen-aangevinkte-modules', async () => {
      const tier = await makeTier('regressiestandaard', 300);
      const modR = await req('POST', '/api/modules', {
        token: sysadminToken, body: { key: `${PREFIX}-regressiemodule`, name: 'Regressiemodule test' },
      });
      assert.equal(modR.status, 201, JSON.stringify(modR.body));
      const mod = modR.body;

      const email = `${PREFIX}-regressiestandaard@test.local`;
      const created = await req('POST', '/api/subscription-requests', {
        body: {
          organizationName: `${PREFIX} RegressieStandaard`, applicantName: 'X', applicantEmail: email,
          password: 'wachtwoord123', tierId: tier.id, moduleKeys: [], // bewust geen modules gekozen
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const tenantId = created.body.tenantId as number;

      const list = await req('GET', '/api/subscription-requests', { token: sysadminToken });
      const row = list.body.find((r: any) => r.requestId === created.body.requestId || r.id === created.body.requestId);
      assert.equal(row.licenseEndDate, addDaysStr(today(), 14), 'zonder eigen trialDays blijft de standaardduur gelden');

      const license = await req('GET', `/api/tenants/${tenantId}/license`, { token: sysadminToken });
      assert.deepEqual(license.body.activeModules, [], 'zonder allModulesIncluded blijft alleen-aangevinkte-modules het gedrag, en er was niets aangevinkt');
      void mod;
    });
  });

  // Telefoonnummer (db/migrations/0019_applicant_phone.sql) + het sorteerbare
  // abonnementenoverzicht-endpoint (web/src/pages/SubscriptionOverviewPage.tsx)
  // — verzoek van Charles (30 augustus 2026): "welk abonnement bij de tenant
  // hoort, tot wanneer, wie de aanvrager is en wat het email/tel nummer is."
  describe('telefoonnummer bij aanvraag + abonnementenoverzicht (GET /api/subscription-requests/overview)', () => {
    it('POST /api/subscription-requests slaat een optioneel telefoonnummer op, of laat het leeg (null)', async () => {
      const tier = await makeTier('meteltelefoon', 250);

      const metTelefoon = await req('POST', '/api/subscription-requests', {
        body: {
          organizationName: `${PREFIX} MetTelefoon`, applicantName: 'Y', applicantEmail: `${PREFIX}-mettel@test.local`,
          applicantPhone: '06-12345678', password: 'wachtwoord123', tierId: tier.id, moduleKeys: [],
        },
      });
      assert.equal(metTelefoon.status, 201, JSON.stringify(metTelefoon.body));

      const zonderTelefoon = await req('POST', '/api/subscription-requests', {
        body: {
          organizationName: `${PREFIX} ZonderTelefoon`, applicantName: 'Z', applicantEmail: `${PREFIX}-zondertel@test.local`,
          password: 'wachtwoord123', tierId: tier.id, moduleKeys: [], // geen applicantPhone meegegeven
        },
      });
      assert.equal(zonderTelefoon.status, 201, JSON.stringify(zonderTelefoon.body));

      const list = await req('GET', '/api/subscription-requests', { token: sysadminToken });
      const rowMet = list.body.find((r: any) => r.id === metTelefoon.body.requestId);
      const rowZonder = list.body.find((r: any) => r.id === zonderTelefoon.body.requestId);
      assert.equal(rowMet.applicantPhone, '06-12345678');
      assert.equal(rowZonder.applicantPhone, null);
    });

    it('GET /api/subscription-requests/overview is sysadmin-only', async () => {
      const anon = await req('GET', '/api/subscription-requests/overview');
      assert.equal(anon.status, 401);

      const setup = await setupWritableDoelenboom(sysadminToken, unique(`${PREFIX}-nietsysadmin`));
      const nietSysadmin = await req('GET', '/api/subscription-requests/overview', { token: setup.adminToken });
      assert.equal(nietSysadmin.status, 403);
    });

    it('GET /api/subscription-requests/overview toont één rij per tenant, ook een handmatig aangemaakte tenant zonder aanvraag', async () => {
      const tier = await makeTier('overview', 250);
      const email = `${PREFIX}-overview@test.local`;
      const created = await req('POST', '/api/subscription-requests', {
        body: {
          organizationName: `${PREFIX} Overview`, applicantName: 'Overview Aanvrager', applicantEmail: email,
          applicantPhone: '020-1234567', password: 'wachtwoord123', tierId: tier.id, moduleKeys: [],
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));

      const handmatigSlug = unique(`${PREFIX}-handmatig`);
      const handmatig = await req('POST', '/api/tenants', {
        token: sysadminToken, body: { slug: handmatigSlug, name: handmatigSlug },
      });
      assert.equal(handmatig.status, 201, JSON.stringify(handmatig.body));

      const overview = await req('GET', '/api/subscription-requests/overview', { token: sysadminToken });
      assert.equal(overview.status, 200, JSON.stringify(overview.body));

      const zelfbediening = overview.body.find((r: any) => r.tenantId === created.body.tenantId);
      assert.ok(zelfbediening, 'de zelfbedieningstenant moet in het overzicht staan');
      assert.equal(zelfbediening.tierName, tier.name);
      assert.equal(zelfbediening.applicantName, 'Overview Aanvrager');
      assert.equal(zelfbediening.applicantEmail, email);
      assert.equal(zelfbediening.applicantPhone, '020-1234567');
      assert.equal(zelfbediening.status, 'proef');
      assert.ok(zelfbediening.licenseEndDate, 'proeftenant moet een verloopdatum hebben');

      const rijHandmatig = overview.body.find((r: any) => r.tenantId === handmatig.body.id);
      assert.ok(rijHandmatig, 'ook een handmatig (niet via zelfbediening) aangemaakte tenant moet in het overzicht staan');
      assert.equal(rijHandmatig.tierName, null);
      assert.equal(rijHandmatig.applicantName, null);
      assert.equal(rijHandmatig.applicantEmail, null);
      assert.equal(rijHandmatig.applicantPhone, null);
      assert.equal(rijHandmatig.status, null);
    });
  });
});

import { pool } from './db.js';

// Verlengingsherinnering voor aflopende licenties (Klantbeheer, zie
// db/migrations/0033_customer_management.sql) — een periodieke sweep
// (aangeroepen vanuit index.ts, zelfde opzet als accountRetention.ts en
// tenantRetention.ts) die tenants signaleert wier licentie-einddatum binnen
// LICENSE_RENEWAL_REMINDER_DAYS ligt.
//
// Net als accountRetention.ts sendInactivityWarning hierboven: er bestaat op
// dit moment nergens in dit project een mailprovider, dus dit is voorlopig
// een log-only stub ("Nu alleen loggen, mail later aansluiten" — zelfde
// opdrachtgeverskeuze als bij de accountretentie-waarschuwing). Het
// aanroepende punt en de idempotentie hieronder staan al volledig op orde;
// het enige dat later verandert is de inhoud van sendRenewalReminder.
//
// Idempotentie: tenants.license_renewal_reminder_sent_at (zie migratie 0033)
// zorgt dat een tenant maar één keer per aflopende licentie een herinnering
// krijgt, ongeacht hoe vaak de sweep draait — license.ts
// setTenantLicenseEndDate zet dit veld terug naar null zodra de einddatum
// zelf wijzigt, zodat een verlengde/nieuwe licentie weer zijn eigen
// herinneringscyclus krijgt.
export const LICENSE_RENEWAL_REMINDER_DAYS = 30;

export async function sweepLicenseRenewalReminders(): Promise<void> {
  // Alleen tenants die nog niet beëindigd zijn (een beëindigde tenant heeft
  // geen "verlenging" meer nodig, zie tenantRetention.ts) en waarvan de
  // licentie nog niet verlopen is (een verlopen licentie is al read-only en
  // wordt via een ander kanaal opgevolgd, geen "loopt binnenkort af"-signaal
  // meer relevant).
  // to_char i.p.v. de rauwe date-kolom teruggeven — zelfde conventie als
  // license.ts/routes/tenants.ts (LICENSE_END_DATE_SELECT): voorkomt dat de
  // pg-driver hier een DATE-kolom als JS Date-object (of, afhankelijk van
  // parserconfiguratie, als kale string) teruggeeft en dat verschil per
  // omgeving andere code zou vereisen.
  const candidates = await pool.query(
    `select id, name, to_char(license_end_date, 'YYYY-MM-DD') as license_end_date
     from tenants
     where terminated_at is null
       and license_end_date is not null
       and license_end_date >= current_date
       and license_end_date <= current_date + interval '${LICENSE_RENEWAL_REMINDER_DAYS} days'
       and license_renewal_reminder_sent_at is null`
  );

  for (const row of candidates.rows) {
    const tenantId = row.id as number;
    try {
      await sendRenewalReminder(tenantId, row.name as string, row.license_end_date as string);
      await pool.query('update tenants set license_renewal_reminder_sent_at = now() where id = $1', [tenantId]);
    } catch (err) {
      console.error(`[licenseRenewalReminder] Herinnering voor tenant ${tenantId} mislukt (sweep gaat door):`, err);
    }
  }
}

async function sendRenewalReminder(tenantId: number, tenantName: string, licenseEndDate: string): Promise<void> {
  // TODO: vervang door een echte mailprovider zodra die is gekozen/aangesloten.
  console.log(
    `[licenseRenewalReminder] (log-only, geen mailprovider aangesloten) ` +
      `Zou verlengingsherinnering sturen voor tenant "${tenantName}" (${tenantId}): ` +
      `licentie loopt af op ${licenseEndDate}`
  );
}

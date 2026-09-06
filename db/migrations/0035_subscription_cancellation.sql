-- Abonnement-opzegging, analoog aan een verzekeringspolis — Charles' verzoek
-- (6 september 2026): "Contractreferentie - zowel die van de klant als die
-- van ons abonnement hebben een status, net als bij een verzekeringspolis.
-- Pas als deze opgezegd is, gaat deze op einddatum op readonly."
--
-- Tot nu toe was tenants.license_end_date de enige, onvoorwaardelijke
-- afdwingingsdatum (zie api/src/license.ts isLicenseExpired): zodra die
-- passeerde ging de tenant sowieso op alleen-lezen, ook als er nooit een
-- opzegging is geweest. Voor een lopend (betaald) abonnement is dat niet wat
-- Charles wil: zoals een polis loopt het gewoon door totdat het expliciet is
-- opgezegd — de einddatum is dan pas het moment waarop de opzegging
-- daadwerkelijk ingaat. subscription_cancelled_at (null = "loopt door", gezet
-- = "opgezegd op dit tijdstip") legt dat vast; zie license.ts
-- setSubscriptionCancelled voor het bijwerken en isLicenseExpired/
-- getTenantLicense voor de bijgewerkte afdwingingsregel.
--
-- Geldt bewust NIET voor de proefperiode (subscription_requests.status =
-- 'proef') of een afgewezen aanvraag (status = 'afgewezen', zie
-- subscriptions.ts reject: zet license_end_date bewust op gisteren om de
-- tenant onmiddellijk te blokkeren) — die MOETEN onvoorwaardelijk op hun
-- (eventueel kunstmatig vervroegde) einddatum sluiten, er is dan nooit een
-- opzegging. Alleen een 'actief' abonnement, of een handmatig door een
-- sysadmin aangemaakte tenant zonder subscription_requests-rij, volgt de
-- nieuwe opzeg-regel — zie license.ts isLicenseExpired voor de precieze
-- implementatie.
begin;

alter table tenants add column if not exists subscription_cancelled_at timestamptz;

-- Klantcontract-status: puur informatief (stuurt GEEN toegang aan, in
-- tegenstelling tot subscription_cancelled_at hierboven) — voor Charles' eigen
-- administratie van het contract van de klant zelf (tenant_customer_info.
-- contract_reference), los van "ons" abonnement. Ascii-waarden in de
-- check-constraint (consistent met overige enums in dit schema, zie bv.
-- subscription_requests.status/tenant_contacts.role); het scherm toont de Nederlandse
-- labels met correcte diakritische tekens (zie KlantbeheerPage.tsx).
alter table tenant_customer_info add column if not exists contract_status text not null default 'lopend'
  check (contract_status in ('lopend', 'opgezegd', 'beeindigd'));

commit;

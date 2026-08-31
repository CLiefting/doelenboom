-- Migratie: 'laatst bijgewerkt' (door wie, wanneer) op de projectstatus, en
-- een per-doelenboom instelbare 'verouderd na X dagen'-drempel — zie het
-- verzoek van Charles (31 augustus 2026): projecten die te lang niet meer
-- zijn geactualiseerd moeten in de boom opvallen en filterbaar zijn, zodat je
-- in één oogopslag kunt inschatten of de boom nog actueel is.
--
-- project_status.updated_at/updated_by zijn NULLABLE en bewust GEEN kopie van
-- gerapporteerd_op (dat is een vrij invoerbare, zelf-gerapporteerde datum —
-- iemand kan daar elke datum intypen). updated_at/updated_by worden alleen
-- door de server gezet (now() + de ingelogde gebruiker), bij elke opslag van
-- de projectstatus (PUT) én bij de losse "markeer als gecontroleerd"-actie
-- (POST .../project-status/touch) — zie api/src/routes/projectStatus.ts.
-- Bestaande rijen hebben nooit via deze nieuwe route een update gehad, dus
-- updated_at is voor hen null; dat betekent bewust "nog nooit bijgewerkt
-- sinds deze functionaliteit bestaat" en telt in isStale()-logica (tree.html)
-- mee als verouderd, niet als "onbekend dus negeren" — anders zou precies de
-- data die het langst is blijven liggen onopgemerkt blijven.
--
-- doelenbomen.stale_after_days: één vaste drempel per doelenboom (i.p.v. per
-- projectstatus of per status-waarde — zie Charles' keuze in het interview),
-- default 60 dagen, door een doelenboom-/tenant-admin aan te passen via de
-- doelenboom-instellingen (PUT /api/doelenbomen/:id, TenantManagementPage).
alter table project_status add column if not exists updated_at timestamptz;
alter table project_status add column if not exists updated_by bigint references users(id) on delete set null;

alter table doelenbomen add column if not exists stale_after_days integer not null default 60
  check (stale_after_days between 1 and 3650);

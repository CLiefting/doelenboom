-- Migratie: volledige wijzigingshistorie van de projectstatus (before/after-
-- waarden per veld, wie en wanneer) -- vervolg-interview met Charles
-- (31 augustus 2026, n.a.v. project "Sweepen"): de "laatst bijgewerkt"-
-- markering (zie 0020_project_status_review.sql) laat alleen het láátste
-- moment zien, niet wát er is gewijzigd of wat eraan vooraf ging.
--
-- Elke PUT (project-status.ts) en elke "Vandaag gecontroleerd"-touch-actie
-- schrijft een rij weg. is_touch onderscheidt de twee: bij een touch zijn
-- prev_* en new_* gelijk (er is inhoudelijk niets gewijzigd, alleen de
-- "laatst gecontroleerd"-datum is bijgewerkt) -- zie Charles' keuze om ook
-- touch-acties te laten meetellen, gelabeld als "gecontroleerd, niets
-- gewijzigd" i.p.v. als een echte wijziging (zie tree.html-weergave).
-- Een DELETE (status wissen) schrijft ook een rij weg, met new_* = null
-- (alle kolommen), zodat "verwijderd" net zo goed als wijziging zichtbaar is.
--
-- prev_* is null wanneer er nog geen project_status-rij bestond (eerste keer
-- dat een status wordt gezet) -- dat is dus geen "leeg" (wat een geldige,
-- bewust ingevulde waarde is, zie project_status.projectstatus/rag), maar
-- "bestond nog niet".
--
-- Voor altijd bewaard, geen opschoning (zie Charles' keuze: een paar
-- wijzigingen per project per jaar, blijft klein).
create table if not exists project_status_history (
  id bigserial primary key,
  element_id bigint not null references elements(id) on delete cascade,
  changed_at timestamptz not null default now(),
  changed_by bigint references users(id) on delete set null,
  is_touch boolean not null default false,
  prev_projectstatus text,
  prev_rag text,
  prev_toelichting text,
  prev_gerapporteerd_op date,
  prev_cluster_ppt text,
  new_projectstatus text,
  new_rag text,
  new_toelichting text,
  new_gerapporteerd_op date,
  new_cluster_ppt text
);

create index if not exists idx_project_status_history_element
  on project_status_history (element_id, changed_at desc);

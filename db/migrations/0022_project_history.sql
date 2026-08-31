-- Migratie: generieke wijzigingshistorie per project-element (niet meer
-- alleen projectstatus) — vervolg op 0021_project_status_history.sql, die
-- dezelfde dag alweer te krap bleek: Charles wilde ook deliverable- en
-- activiteiten-wijzigingen in dezelfde historie-tijdlijn terugzien, én laten
-- meetellen voor de 'verouderd'-markering van het project (zie het
-- vervolg-interview: "elke wijziging aan projectinhoud telt mee" en "in
-- dezelfde historie-lijst").
--
-- Vervangt project_status_history door één generieke tabel met een
-- kind-kolom ('status'/'product'/'activity') i.p.v. per-kind vaste
-- before/after-kolommen — anders zou elke nieuwe "soort" wijziging weer een
-- eigen setje kolommen nodig hebben. `changes` is een JSONB-object van
-- { veldnaam: { from, to } } met ALLEEN de daadwerkelijk gewijzigde velden,
-- zodat de vorm per kind kan verschillen zonder tientallen nullable
-- kolommen. `label` is de naam/code van het product/de activiteit (context
-- in de tijdlijn) — leeg voor kind='status', waar de wijzigingen zelf al
-- voldoende context geven.
--
-- project_status_history bestond nog maar kort (dezelfde dag aangemaakt) en
-- had in de praktijk nog geen betekenisvolle data — vandaar een schone
-- vervanging i.p.v. een dataconversie.
drop table if exists project_status_history;

create table if not exists project_history (
  id bigserial primary key,
  element_id bigint not null references elements(id) on delete cascade,
  changed_at timestamptz not null default now(),
  changed_by bigint references users(id) on delete set null,
  kind text not null check (kind in ('status', 'product', 'activity')),
  action text not null check (action in ('create', 'update', 'delete', 'touch')),
  label text not null default '',
  changes jsonb not null default '{}'::jsonb
);

create index if not exists idx_project_history_element
  on project_history (element_id, changed_at desc);

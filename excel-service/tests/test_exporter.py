"""Tests voor app/exporter.py — bouwt template/data-workbooks en laadt ze terug
in openpyxl om headers, datarijen en (voor het nieuwe formaat) de dropdown-
validatie te controleren."""
from __future__ import annotations

import io

from openpyxl import load_workbook

from app.exporter import (
    NIEUW_SHEET_HEADERS, OUD_SHEET_HEADERS, build_data_workbook, build_template_workbook,
)
from tests.helpers import make_tree


def load(content: bytes):
    return load_workbook(io.BytesIO(content))


class TestTemplateWorkbook:
    def test_oud_template_heeft_alle_tabbladen_met_alleen_headers(self):
        wb = load(build_template_workbook('oud'))
        for name, headers in OUD_SHEET_HEADERS.items():
            ws = wb[name]
            assert [c.value for c in ws[1]] == headers
            assert ws.max_row == 1  # geen datarijen
        assert 'Configuratie' in wb.sheetnames

    def test_nieuw_template_heeft_validatielijsten_en_dropdowns(self):
        wb = load(build_template_workbook('nieuw'))
        for name, headers in NIEUW_SHEET_HEADERS.items():
            assert [c.value for c in wb[name][1]] == headers
        assert '_Validatielijsten' in wb.sheetnames

        ref_ws = wb['Referentietabel']
        # De Type-dropdown staat op kolom B (B2:B10000, zie exporter.py
        # _apply_data_validation) en verwijst naar de _Validatielijsten-tab —
        # de dropdown zelf draagt de tekst "Type" niet, dus zoeken op de
        # celrange i.p.v. op de formuletekst.
        type_dvs = [dv for dv in ref_ws.data_validations.dataValidation if 'B2:B10000' in str(dv.sqref)]
        assert type_dvs, 'verwacht een Type-dropdown op de Referentietabel'
        assert '_Validatielijsten' in type_dvs[0].formula1

    def test_configuratie_tab_bevat_meta(self):
        wb = load(build_template_workbook('oud', {'doelenboom': 'Mijn boom', 'tenant': 'Mijn tenant'}))
        rows = {row[0].value: row[1].value for row in wb['Configuratie'].iter_rows(min_row=2)}
        assert rows['Doelenboom'] == 'Mijn boom'
        assert rows['Tenant'] == 'Mijn tenant'
        assert rows['Formaat'] == 'Oud'
        assert rows['Modus'] == 'Lege template'


class TestDataWorkbookOud:
    def test_referentietabel_bevat_elementrijen(self):
        tree = make_tree()
        wb = load(build_data_workbook('oud', tree))
        ws = wb['Referentietabel']
        codes = [row[0].value for row in ws.iter_rows(min_row=2)]
        assert codes == ['OB1', 'C1', 'P1']

    def test_edges_verdeeld_over_de_twee_relatietabbladen(self):
        tree = make_tree()
        wb = load(build_data_workbook('oud', tree))
        cap_ob = [tuple(c.value for c in row) for row in wb['Capability-OB relaties'].iter_rows(min_row=2)]
        proj_cap = [tuple(c.value for c in row) for row in wb['Project-Capability relaties'].iter_rows(min_row=2)]
        assert cap_ob == [('C1', 'Capability 1', 'OB1', 'OB 1', 'Primair', 'Waarom C1->OB1')]
        # Een leeg-tekst-cel ('') komt bij het opnieuw inladen van het .xlsx-
        # bestand terug als None (openpyxl-gedrag, geen bug) — parser.py's
        # clean_text() behandelt beide gelijk, dus dat is verderop onschadelijk.
        assert proj_cap == [('P1', 'Project 1', 'C1', 'Capability 1', 'Ondersteunend', None)]

    def test_producten_bevatten_type_kolom(self):
        tree = make_tree()
        wb = load(build_data_workbook('oud', tree))
        rows = [tuple(c.value for c in row) for row in wb['Producten'].iter_rows(min_row=2)]
        assert rows[0][4] == 'deliverable'
        assert rows[1][4] == 'mijlpaal'

    def test_projecten_tab_bevat_status_en_cluster(self):
        tree = make_tree()
        wb = load(build_data_workbook('oud', tree))
        row = next(wb['Projecten'].iter_rows(min_row=2, values_only=True))
        assert row[0] == 'P1'
        assert row[2] == 'Cluster A'
        assert row[3] == 'Actief'
        assert row[4] == 'Groen'

    def test_tags_en_org_units_worden_geschreven(self):
        tree = make_tree()
        wb = load(build_data_workbook('oud', tree))
        assert next(wb['Tags'].iter_rows(min_row=2, values_only=True))[:2] == ('T1', 'Tag 1')
        assert next(wb['Organisatieonderdelen'].iter_rows(min_row=2, values_only=True))[:2] == ('O1', 'Org-unit 1')


class TestDataWorkbookNieuw:
    def test_relaties_tab_bevat_alle_edges_in_een_tabblad(self):
        tree = make_tree()
        wb = load(build_data_workbook('nieuw', tree))
        rows = [tuple(c.value for c in row) for row in wb['Relaties'].iter_rows(min_row=2)]
        # Zie de toelichting bij test_edges_verdeeld_over_de_twee_relatietabbladen
        # hierboven — een lege toelichting-cel komt terug als None, niet ''.
        assert rows == [('C1', 'OB1', 'Primair', 'Waarom C1->OB1'), ('P1', 'C1', 'Ondersteunend', None)]

    def test_referentietabel_heeft_volgorde_en_actief_kolom(self):
        tree = make_tree()
        wb = load(build_data_workbook('nieuw', tree))
        headers = [c.value for c in wb['Referentietabel'][1]]
        assert headers == NIEUW_SHEET_HEADERS['Referentietabel']
        row = next(wb['Referentietabel'].iter_rows(min_row=2, values_only=True))
        assert row[-1] == 'Ja'  # Actief

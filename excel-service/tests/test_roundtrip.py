"""Rondgang-tests: build_data_workbook() (exporter) -> parse_workbook() (parser)
moet dezelfde inhoud opleveren als waarmee begonnen is. Dit is de geautomatiseerde
vorm van het eenmalige, handmatige round-trip-testje dat eerder deze sessie werd
gebruikt om de nieuwe Type-kolom op Producten te verifiëren (zie de sessie-
samenvatting) — nu een blijvend onderdeel van de suite i.p.v. eenmalig.

Let op: het "oud" Excel-formaat heeft alleen een eigen tabblad voor Capability->
Operationele-benefit- en Project->Capability-edges (zie het commentaar in
exporter.py bij _fill_oud) — andere edge-vormen (bv. rechtstreeks Project-
>Missie) round-trippen daar bewust niet. De fixture hieronder (tests/helpers.py,
make_tree()) gebruikt daarom uitsluitend edges die wél in beide formaten
round-trippen, zodat deze test iets zinvols verifieert i.p.v. een bekende
beperking te herontdekken."""
from __future__ import annotations

import pytest

from app.exporter import build_data_workbook
from app.parser import parse_workbook
from tests.helpers import make_columns, make_tree


@pytest.mark.parametrize('format_', ['oud', 'nieuw'])
def test_volledige_rondgang(format_):
    tree = make_tree()
    xlsx = build_data_workbook(format_, tree)
    status, report, parsed = parse_workbook(xlsx)

    assert status == 'ok', report['warnings']

    assert {(e['code'], e['type'], e['name']) for e in parsed['elements']} == {
        ('OB1', 'Operationele benefit', 'OB 1'),
        ('C1', 'Capability', 'Capability 1'),
        ('P1', 'Project', 'Project 1'),
    }

    assert {(e['source'], e['target'], e['weight']) for e in parsed['edges']} == {
        ('C1', 'OB1', 'primair'),
        ('P1', 'C1', 'ondersteunend'),
    }

    ps = parsed['projectStatus']['P1']
    assert ps['projectstatus'] == 'Actief'
    assert ps['rag'] == 'Groen'
    assert ps['clusterPpt'] == 'Cluster A'
    assert ps['gerapporteerdOp'] == '2026-03-01'

    products_by_name = {p['name']: p for p in parsed['products']['P1']}
    assert products_by_name['Deliverable 1']['type'] == 'deliverable'
    assert products_by_name['Deliverable 1']['pctGereed'] == 40
    assert products_by_name['Deliverable 1']['verwachteDatum'] == '2026-09-01'
    assert products_by_name['Mijlpaal 1']['type'] == 'mijlpaal'

    assert parsed['tags'] == [{'code': 'T1', 'name': 'Tag 1', 'categorie': 'Categorie A', 'omschrijving': ''}]
    assert parsed['elementTags']['P1'] == ['T1']

    assert parsed['orgUnits'] == [{'code': 'O1', 'name': 'Org-unit 1', 'omschrijving': ''}]
    assert parsed['obOrg']['OB1'][0]['org'] == 'O1'
    assert parsed['obOrg']['OB1'][0]['status'] == 'Gevalideerd'


@pytest.mark.parametrize('format_', ['oud', 'nieuw'])
def test_rondgang_zonder_warnings_of_errors(format_):
    tree = make_tree()
    xlsx = build_data_workbook(format_, tree)
    status, report, _ = parse_workbook(xlsx)
    assert status == 'ok'
    assert report['warnings'] == []
    assert report['errors'] == []


def test_rondgang_met_volledig_eigen_kolomconfiguratie():
    # Kolomconfiguratie (zie docs/kolommen-configuratie-ontwerp.md) — een
    # tenant met compleet eigen, niet-standaard types. Alleen zinvol voor het
    # 'nieuw' formaat: 'oud' hardcodeert Capability/Operationele benefit/
    # Project (zie exporter.py::_fill_oud) en wordt hiervoor sowieso al
    # geblokkeerd op API-niveau (zie is_standard_columns, routes/exports.ts).
    columns = make_columns(['Initiatief', 'Vermogen', 'Ambitie'])
    tree = make_tree(
        columns=columns,
        elements=[
            {'code': 'I1', 'type': 'Initiatief', 'name': 'Init 1', 'description': '', 'parent_text': '',
             'kpi': '', 'taakveld': '', 'subtaakveld': '', 'sort_order': 1},
            {'code': 'V1', 'type': 'Vermogen', 'name': 'Verm 1', 'description': '', 'parent_text': '',
             'kpi': '', 'taakveld': '', 'subtaakveld': '', 'sort_order': 2},
            {'code': 'A1', 'type': 'Ambitie', 'name': 'Onze ambitie', 'description': '', 'parent_text': '',
             'kpi': '', 'taakveld': '', 'subtaakveld': '', 'sort_order': 3},
        ],
        edges=[{'source': 'I1', 'target': 'V1', 'weight': None, 'toelichting': ''}],
        projectStatus={}, products={}, tags=[], elementTags={}, orgUnits=[], obOrg={},
    )
    xlsx = build_data_workbook('nieuw', tree)
    status, report, parsed = parse_workbook(xlsx, valid_types=['Initiatief', 'Vermogen', 'Ambitie'])
    assert status == 'ok', report['warnings']
    assert {(e['code'], e['type']) for e in parsed['elements']} == {
        ('I1', 'Initiatief'), ('V1', 'Vermogen'), ('A1', 'Ambitie'),
    }


def test_lege_boom_exporteert_en_importeert_zonder_te_crashen():
    tree = make_tree(elements=[], edges=[], projectStatus={}, products={}, tags=[], elementTags={}, orgUnits=[], obOrg={})
    for format_ in ('oud', 'nieuw'):
        xlsx = build_data_workbook(format_, tree)
        status, report, parsed = parse_workbook(xlsx)
        # Een boom zonder elementen heeft geen bruikbare Referentietabel-rijen —
        # dat is en blijft terecht 'failed' (zie parser.py), net als bij een
        # echte, per ongeluk lege upload.
        assert status == 'failed'
        assert parsed is None

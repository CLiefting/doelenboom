"""Gedeelde helpers voor de excel-service-testsuite.

build_workbook_bytes bouwt een .xlsx (als bytes, precies zoals parse_workbook()
ze binnenkrijgt vanuit de upload-route) met de opgegeven tabbladen/kolomkoppen/
rijen — zonder een documentatie-.xlsx erbij te hoeven bewaren. make_tree bouwt
een minimale, maar volledige TreeResponse-achtige dict (dezelfde vorm als
api/src/routes/tree.ts.fetchTree() teruggeeft) als input voor de exporter.
"""
from __future__ import annotations

import io
from typing import Any

from openpyxl import Workbook


def build_workbook_bytes(sheets: dict[str, list[list[Any]]]) -> bytes:
    """sheets: {sheetnaam: [headerrij, datarij, datarij, ...]}."""
    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(name)
        for row in rows:
            ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def make_tree(**overrides: Any) -> dict[str, Any]:
    tree: dict[str, Any] = {
        'elements': [
            {
                'code': 'OB1', 'type': 'Operationele benefit', 'name': 'OB 1',
                'description': 'Beschrijving OB1', 'parent_text': '', 'kpi': 'KPI-1',
                'taakveld': 'IT', 'subtaakveld': 'Beheer', 'sort_order': 1,
            },
            {
                'code': 'C1', 'type': 'Capability', 'name': 'Capability 1',
                'description': '', 'parent_text': '', 'kpi': '', 'taakveld': '', 'subtaakveld': '', 'sort_order': 2,
            },
            {
                'code': 'P1', 'type': 'Project', 'name': 'Project 1',
                'description': '', 'parent_text': '', 'kpi': '', 'taakveld': '', 'subtaakveld': '', 'sort_order': 3,
            },
        ],
        'edges': [
            {'source': 'C1', 'target': 'OB1', 'weight': 'primair', 'toelichting': 'Waarom C1->OB1'},
            {'source': 'P1', 'target': 'C1', 'weight': 'ondersteunend', 'toelichting': ''},
        ],
        'projectStatus': {
            'P1': {
                'projectstatus': 'Actief', 'rag': 'Groen', 'toelichting': 'Op schema',
                'gerapporteerdOp': '2026-03-01', 'clusterPpt': 'Cluster A',
            },
        },
        'products': {
            'P1': [
                {
                    'code': 'PR1', 'name': 'Deliverable 1', 'type': 'deliverable',
                    'omschrijving': 'Omschrijving', 'pctGereed': 40,
                    'verwachteDatum': '2026-09-01', 'werkelijkeDatum': None, 'opmerking': '',
                },
                {
                    'code': 'PR2', 'name': 'Mijlpaal 1', 'type': 'mijlpaal',
                    'omschrijving': '', 'pctGereed': 0,
                    'verwachteDatum': '2026-12-01', 'werkelijkeDatum': None, 'opmerking': '',
                },
            ],
        },
        'tags': [
            {'code': 'T1', 'name': 'Tag 1', 'categorie': 'Categorie A', 'omschrijving': ''},
        ],
        'elementTags': {'P1': ['T1']},
        'orgUnits': [
            {'code': 'O1', 'name': 'Org-unit 1', 'omschrijving': ''},
        ],
        'obOrg': {
            'OB1': [
                {'org': 'O1', 'relatietype': 'Primair', 'toelichting': '', 'status': 'Gevalideerd'},
            ],
        },
    }
    tree.update(overrides)
    return tree

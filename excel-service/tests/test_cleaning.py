"""Unit tests voor app/cleaning.py — de celopschoning-regels uit
doelenboom_update_instructie.md §3.2 (zie het docstring-commentaar bovenaan
cleaning.py voor de volledige lijst regels)."""
from __future__ import annotations

import datetime

from app.cleaning import clean_date, clean_pct, clean_text, norm


class TestCleanText:
    def test_none_wordt_lege_string(self):
        assert clean_text(None) == ''

    def test_literal_nul_in_tekstveld_wordt_leeg(self):
        assert clean_text(0) == ''
        assert clean_text(0.0) == ''

    def test_geen_fpbb_kpi_wordt_streepje(self):
        assert clean_text('Geen FPBB-KPI') == '-'

    def test_whitespace_wordt_genormaliseerd_en_getrimd(self):
        assert clean_text('  Meerdere   spaties  \n en een regeleinde ') == 'Meerdere spaties en een regeleinde'

    def test_gewone_tekst_blijft_ongewijzigd(self):
        assert clean_text('Gewone tekst') == 'Gewone tekst'

    def test_getal_ongelijk_aan_nul_wordt_string(self):
        assert clean_text(42) == '42'


class TestCleanDate:
    def test_none_wordt_none(self):
        assert clean_date(None) is None

    def test_lege_tijd_00_00_wordt_none(self):
        assert clean_date(datetime.time(0, 0)) is None

    def test_excel_epoch_artefact_wordt_none(self):
        assert clean_date(datetime.datetime(1899, 12, 30)) is None

    def test_datetime_wordt_iso_datum_string(self):
        assert clean_date(datetime.datetime(2026, 9, 15, 13, 45)) == '2026-09-15'

    def test_date_object_wordt_iso_string(self):
        assert clean_date(datetime.date(2026, 9, 15)) == '2026-09-15'

    def test_string_wordt_getrimd(self):
        assert clean_date('  2026-09-15  ') == '2026-09-15'


class TestCleanPct:
    def test_none_wordt_nul(self):
        assert clean_pct(None) == 0

    def test_fractie_0_tot_1_wordt_percentage(self):
        assert clean_pct(0.4) == 40
        assert clean_pct(1) == 100
        assert clean_pct(0) == 0

    def test_waarde_boven_1_wordt_als_percentage_gelaten(self):
        assert clean_pct(40) == 40
        assert clean_pct(75.6) == 76  # rond af

    def test_niet_numerieke_waarde_wordt_nul(self):
        assert clean_pct('onzin') == 0


class TestNorm:
    def test_case_en_whitespace_ongevoelig(self):
        assert norm('  Operationele   Benefit ') == 'operationele benefit'

    def test_none_wordt_lege_string(self):
        assert norm(None) == ''

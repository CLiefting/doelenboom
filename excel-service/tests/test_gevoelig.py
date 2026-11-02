"""DOEL-133: Excel-bestanden uit de kluis krijgen het kenmerk "gevoelig", en
/parse en /project-parse melden dat kenmerk, zodat de API zo'n bestand buiten
de kluis kan weigeren. Op de oude code falen deze tests (app.gevoelig bestond
niet en de parse-routes gaven geen "gevoelig" terug)."""
from __future__ import annotations

import io
import zipfile

from fastapi.testclient import TestClient
from openpyxl import load_workbook

from app.exporter import build_data_workbook, build_template_workbook
from app.gevoelig import PROPERTY_NAME, is_gevoelig, markeer
from app.main import app
from app.project_workbook import build_project_workbook
from tests.helpers import make_tree, standard_columns
from tests.test_project_workbook import make_data, make_meta

client = TestClient(app)
KLUIS = {'doelenboom': 'Geheim', 'tenant': 'T', 'gevoelig': True}


def _props(content: bytes) -> dict[str, str]:
    wb = load_workbook(io.BytesIO(content))
    return {p.name: p.value for p in wb.custom_doc_props}


def _upload(path: str, content: bytes):
    return client.post(path, files={'file': ('x.xlsx', content, 'application/octet-stream')})


class TestMarkeren:
    def test_doelenboom_export_uit_de_kluis_heeft_het_kenmerk_en_een_zichtbare_regel(self):
        content = build_data_workbook('oud', make_tree(columns=standard_columns()), KLUIS, columns=standard_columns())
        assert _props(content) == {PROPERTY_NAME: 'ja'}
        assert is_gevoelig(content)
        cfg = load_workbook(io.BytesIO(content))['Configuratie']
        assert any(r[0] == 'Gevoelig' and str(r[1]).startswith('JA') for r in cfg.iter_rows(values_only=True))

    def test_lege_template_en_project_export_uit_de_kluis_ook(self):
        assert is_gevoelig(build_template_workbook('nieuw', KLUIS, columns=standard_columns()))
        meta = {**make_meta(), 'gevoelig': True}
        assert is_gevoelig(build_project_workbook(make_data(), meta))

    def test_buiten_de_kluis_geen_kenmerk(self):
        for meta in ({}, {'gevoelig': False}, {'gevoelig': 'true'}, {'gevoelig': 1}, None):
            content = build_data_workbook('oud', make_tree(columns=standard_columns()), meta, columns=standard_columns())
            assert not is_gevoelig(content), meta
            assert PROPERTY_NAME not in _props(content)
        assert not is_gevoelig(build_project_workbook(make_data(), make_meta()))

    def test_markeer_is_idempotent(self):
        from openpyxl import Workbook
        wb = Workbook()
        markeer(wb, KLUIS)
        markeer(wb, KLUIS)
        assert wb.custom_doc_props.names.count(PROPERTY_NAME) == 1


class TestHerkennen:
    def test_geen_xlsx_of_kapot_bestand_telt_niet_als_gevoelig(self):
        assert not is_gevoelig(b'')
        assert not is_gevoelig(b'geen zip')

    def test_kenmerk_met_hoofdletters_telt_ook(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as zf:
            zf.writestr('docProps/custom.xml',
                        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties">'
                        '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Doelenboom_Gevoelig"/>'
                        '</Properties>')
        assert is_gevoelig(buf.getvalue())

    def test_verdacht_grote_of_onleesbare_custom_xml_telt_als_gevoelig(self):
        for body in ('<' + 'a' * (300 * 1024), '<niet-afgesloten'):
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, 'w') as zf:
                zf.writestr('docProps/custom.xml', body)
            assert is_gevoelig(buf.getvalue())

    def test_xml_entiteiten_worden_niet_uitgevoerd(self):
        # defusedxml weigert DTD-entiteiten (billion laughs); dan "gevoelig", nooit een crash.
        bom = ('<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]>'
               '<Properties><property name="&b;"/></Properties>')
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as zf:
            zf.writestr('docProps/custom.xml', bom)
        assert is_gevoelig(buf.getvalue())


class TestParseRoutes:
    def test_parse_meldt_gevoelig_en_leest_het_bestand_verder_gewoon(self):
        cols = standard_columns()
        gevoelig = build_data_workbook('oud', make_tree(columns=cols), KLUIS, columns=cols)
        gewoon = build_data_workbook('oud', make_tree(columns=cols), {}, columns=cols)
        r1, r2 = _upload('/parse', gevoelig).json(), _upload('/parse', gewoon).json()
        assert r1['gevoelig'] is True and r2['gevoelig'] is False
        assert r1['status'] == r2['status'] and r1['parsed'] == r2['parsed']

    def test_project_parse_meldt_gevoelig(self):
        meta = {**make_meta(), 'gevoelig': True}
        assert _upload('/project-parse', build_project_workbook(make_data(), meta)).json()['gevoelig'] is True
        assert _upload('/project-parse', build_project_workbook(make_data(), make_meta())).json()['gevoelig'] is False

    def test_export_route_zet_het_kenmerk_alleen_met_meta_gevoelig(self):
        tree = make_tree(columns=standard_columns())
        on = client.post('/export?format=oud&mode=data', json={'tree': tree, 'meta': {'gevoelig': True}})
        off = client.post('/export?format=oud&mode=data', json={'tree': tree, 'meta': {}})
        assert is_gevoelig(on.content) and not is_gevoelig(off.content)

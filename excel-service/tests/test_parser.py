"""Tests voor app/parser.py — dekt beide formaten (oud/nieuw), de validatie-/
waarschuwingsregels uit doelenboom_update_instructie.md §2, en de "verticale
edges uit Bovenliggend element"-afleiding.

Kolomkoppen komen bewust uit app.exporter (OUD_SHEET_HEADERS/NIEUW_SHEET_HEADERS)
i.p.v. hier los overgetypt — zo blijft deze test automatisch in sync met wat de
exporter daadwerkelijk produceert (en dus ook met wat een echte upload bevat)."""
from __future__ import annotations

from app.exporter import NIEUW_SHEET_HEADERS, OUD_SHEET_HEADERS
from app.parser import parse_workbook
from tests.helpers import build_workbook_bytes


def oud_workbook(ref_rows=(), cap_ob_rows=(), proj_cap_rows=(), proj_rows=(), prod_rows=(),
                  tag_rows=(), et_rows=(), org_rows=(), obo_rows=()):
    return build_workbook_bytes({
        'Referentietabel': [OUD_SHEET_HEADERS['Referentietabel'], *ref_rows],
        'Capability-OB relaties': [OUD_SHEET_HEADERS['Capability-OB relaties'], *cap_ob_rows],
        'Project-Capability relaties': [OUD_SHEET_HEADERS['Project-Capability relaties'], *proj_cap_rows],
        'Projecten': [OUD_SHEET_HEADERS['Projecten'], *proj_rows],
        'Producten': [OUD_SHEET_HEADERS['Producten'], *prod_rows],
        'Tags': [OUD_SHEET_HEADERS['Tags'], *tag_rows],
        'Element-Tag relaties': [OUD_SHEET_HEADERS['Element-Tag relaties'], *et_rows],
        'Organisatieonderdelen': [OUD_SHEET_HEADERS['Organisatieonderdelen'], *org_rows],
        'OB-Organisatie relaties': [OUD_SHEET_HEADERS['OB-Organisatie relaties'], *obo_rows],
    })


def nieuw_workbook(ref_rows=(), rel_rows=(), proj_rows=(), prod_rows=(),
                    tag_rows=(), et_rows=(), org_rows=(), obo_rows=()):
    return build_workbook_bytes({
        'Referentietabel': [NIEUW_SHEET_HEADERS['Referentietabel'], *ref_rows],
        'Relaties': [NIEUW_SHEET_HEADERS['Relaties'], *rel_rows],
        'Projecten': [NIEUW_SHEET_HEADERS['Projecten'], *proj_rows],
        'Producten': [NIEUW_SHEET_HEADERS['Producten'], *prod_rows],
        'Tags': [NIEUW_SHEET_HEADERS['Tags'], *tag_rows],
        'Element-Tag relaties': [NIEUW_SHEET_HEADERS['Element-Tag relaties'], *et_rows],
        'Organisatieonderdelen': [NIEUW_SHEET_HEADERS['Organisatieonderdelen'], *org_rows],
        'OB-Organisatie relaties': [NIEUW_SHEET_HEADERS['OB-Organisatie relaties'], *obo_rows],
    })


class TestFormaatEnBasisvalidatie:
    def test_ontbrekende_referentietabel_faalt(self):
        content = build_workbook_bytes({'Iets anders': [['kop']]})
        status, report, parsed = parse_workbook(content)
        assert status == 'failed'
        assert parsed is None
        assert any('Referentietabel' in e for e in report['errors'])

    def test_kapot_bestand_geeft_failed_zonder_crash(self):
        status, report, parsed = parse_workbook(b'dit is geen xlsx-bestand')
        assert status == 'failed'
        assert parsed is None
        assert report['errors']

    def test_referentietabel_zonder_bruikbare_rijen_faalt(self):
        content = oud_workbook(ref_rows=[])
        status, report, parsed = parse_workbook(content)
        assert status == 'failed'
        assert any('geen bruikbare elementrijen' in e for e in report['errors'])

    def test_oud_formaat_gedetecteerd_zonder_relaties_tab(self):
        content = oud_workbook(ref_rows=[['P1', 'Project', 'Project 1', '', '', '', '', '', '', '', '', '']])
        status, report, parsed = parse_workbook(content)
        assert status == 'ok'
        assert report['format'] == 'oud'
        assert parsed['elements'][0]['code'] == 'P1'

    def test_nieuw_formaat_gedetecteerd_via_relaties_tab(self):
        content = nieuw_workbook(ref_rows=[['P1', 'Project', 'Project 1', '', '', '', '', 1, 'Ja']])
        status, report, parsed = parse_workbook(content)
        assert status == 'ok'
        assert report['format'] == 'nieuw'


class TestReferentietabelRijvalidatie:
    def test_onbekend_type_wordt_overgeslagen_met_warning(self):
        content = oud_workbook(ref_rows=[
            ['X1', 'Onzin type', 'X', '', '', '', '', '', '', '', '', ''],
        ])
        status, report, parsed = parse_workbook(content)
        assert status == 'failed'  # geen enkele bruikbare rij over
        assert any('Onbekend Type-label' in w for w in report['warnings'])

    def test_project_historisch_wordt_genegeerd(self):
        content = oud_workbook(ref_rows=[
            ['P1', 'Project (historisch)', 'Oud project', '', '', '', '', '', '', '', '', ''],
            ['P2', 'Project', 'Huidig project', '', '', '', '', '', '', '', '', ''],
        ])
        status, report, parsed = parse_workbook(content)
        # Het overslaan zelf is geen fout, maar wordt wel als waarschuwing
        # gemeld (zie parser.py) — status is dus 'warning', niet 'ok'.
        assert status == 'warning'
        assert report['counts']['skippedHistorisch'] == 1
        assert [e['code'] for e in parsed['elements']] == ['P2']

    def test_dubbele_elementcode_alleen_eerste_rij_gebruikt(self):
        content = oud_workbook(ref_rows=[
            ['P1', 'Project', 'Eerste', '', '', '', '', '', '', '', '', ''],
            ['P1', 'Project', 'Tweede (dubbel)', '', '', '', '', '', '', '', '', ''],
        ])
        status, report, parsed = parse_workbook(content)
        assert len(parsed['elements']) == 1
        assert parsed['elements'][0]['name'] == 'Eerste'
        assert any('Dubbele elementcode' in w for w in report['warnings'])

    def test_actief_nee_wordt_genegeerd_nieuw_formaat(self):
        content = nieuw_workbook(ref_rows=[
            ['P1', 'Project', 'Actief project', '', '', '', '', 1, 'Ja'],
            ['P2', 'Project', 'Inactief project', '', '', '', '', 2, 'Nee'],
        ])
        status, report, parsed = parse_workbook(content)
        assert [e['code'] for e in parsed['elements']] == ['P1']
        assert report['counts']['skippedInactief'] == 1

    def test_volgorde_kolom_krijgt_voorrang_boven_leesvolgorde(self):
        content = nieuw_workbook(ref_rows=[
            ['P1', 'Project', 'Eerst gelezen, maar Volgorde 5', '', '', '', '', 5, 'Ja'],
            ['P2', 'Project', 'Daarna gelezen, maar Volgorde 1', '', '', '', '', 1, 'Ja'],
        ])
        _, _, parsed = parse_workbook(content)
        by_code = {e['code']: e['sortOrder'] for e in parsed['elements']}
        assert by_code == {'P1': 5, 'P2': 1}


class TestRelaties:
    def test_capability_ob_en_project_capability_relaties_oud(self):
        content = oud_workbook(
            ref_rows=[
                ['OB1', 'Operationele benefit', 'OB 1', '', '', '', '', '', '', '', '', ''],
                ['C1', 'Capability', 'Capability 1', '', '', '', '', '', '', '', '', ''],
                ['P1', 'Project', 'Project 1', '', '', '', '', '', '', '', '', ''],
            ],
            cap_ob_rows=[['C1', 'Capability 1', 'OB1', 'OB 1', 'Primair', 'Waarom']],
            proj_cap_rows=[['P1', 'Project 1', 'C1', 'Capability 1', 'Ondersteunend', '']],
        )
        _, report, parsed = parse_workbook(content)
        edges = {(e['source'], e['target']): e['weight'] for e in parsed['edges']}
        assert edges == {('C1', 'OB1'): 'primair', ('P1', 'C1'): 'ondersteunend'}
        assert report['counts']['edges'] == 2

    def test_relaties_tab_nieuw_formaat(self):
        content = nieuw_workbook(
            ref_rows=[
                ['OB1', 'Operationele benefit', 'OB 1', '', '', '', '', 1, 'Ja'],
                ['C1', 'Capability', 'Capability 1', '', '', '', '', 2, 'Ja'],
            ],
            rel_rows=[['C1', 'OB1', 'Primair', 'Toelichting']],
        )
        _, _, parsed = parse_workbook(content)
        assert parsed['edges'] == [{'source': 'C1', 'target': 'OB1', 'weight': 'primair', 'toelichting': 'Toelichting'}]

    def test_onbekende_elementcode_in_relatie_wordt_overgeslagen(self):
        content = oud_workbook(
            ref_rows=[['C1', 'Capability', 'Capability 1', '', '', '', '', '', '', '', '', '']],
            cap_ob_rows=[['C1', 'Capability 1', 'ONBEKEND', 'x', 'Primair', '']],
        )
        _, report, parsed = parse_workbook(content)
        assert parsed['edges'] == []
        assert report['counts']['missingForeignKeys'] == 1
        assert any('onbekende elementcode' in w for w in report['warnings'])

    def test_verticale_edge_uit_bovenliggend_element_enkel_code(self):
        content = oud_workbook(ref_rows=[
            ['M1', 'Missie', 'Missie 1', '', '', '', '', '', '', '', '', ''],
            ['SD1', 'Strategisch doel', 'Doel 1', '', 'M1', '', '', '', '', '', '', ''],
        ])
        _, _, parsed = parse_workbook(content)
        assert {'source': 'M1', 'target': 'SD1', 'weight': None, 'toelichting': ''} in parsed['edges']

    def test_verticale_edges_samengestelde_tekst_met_gewicht_en_meerdere_codes(self):
        content = oud_workbook(ref_rows=[
            ['SB1', 'Strategische benefit', 'SB 1', '', '', '', '', '', '', '', '', ''],
            ['SB2', 'Strategische benefit', 'SB 2', '', '', '', '', '', '', '', '', ''],
            ['PB1', 'Programmabaat', 'PB 1', '', 'SB1/SB2 primair', '', '', '', '', '', '', ''],
        ])
        _, _, parsed = parse_workbook(content)
        edges = {(e['source'], e['target']): e['weight'] for e in parsed['edges']}
        assert edges == {('SB1', 'PB1'): 'primair', ('SB2', 'PB1'): 'primair'}

    def test_onherleidbare_bovenliggend_element_tekst_geeft_warning(self):
        content = oud_workbook(ref_rows=[
            ['SD1', 'Strategisch doel', 'Doel 1', '', 'Iets wat niet bestaat', '', '', '', '', '', '', ''],
        ])
        _, report, parsed = parse_workbook(content)
        assert parsed['edges'] == []
        assert any('konden niet naar een bekende' in w for w in report['warnings'])


class TestProducten:
    def test_type_mapping_inclusief_milestone_alias(self):
        content = oud_workbook(
            ref_rows=[['P1', 'Project', 'Project 1', '', '', '', '', '', '', '', '', '']],
            prod_rows=[
                ['PR1', 'P1', 'Project 1', 'Deliverable', 'deliverable', '', 50, '', '', ''],
                ['PR2', 'P1', 'Project 1', 'Mijlpaal', 'mijlpaal', '', 0, '', '', ''],
                ['PR3', 'P1', 'Project 1', 'Milestone-alias', 'milestone', '', 0, '', '', ''],
            ],
        )
        _, _, parsed = parse_workbook(content)
        types_by_name = {p['name']: p['type'] for p in parsed['products']['P1']}
        assert types_by_name == {'Deliverable': 'deliverable', 'Mijlpaal': 'mijlpaal', 'Milestone-alias': 'mijlpaal'}

    def test_onbekend_type_valt_terug_op_deliverable_met_warning(self):
        content = oud_workbook(
            ref_rows=[['P1', 'Project', 'Project 1', '', '', '', '', '', '', '', '', '']],
            prod_rows=[['PR1', 'P1', 'Project 1', 'X', 'onzin-type', '', 0, '', '', '']],
        )
        _, report, parsed = parse_workbook(content)
        assert parsed['products']['P1'][0]['type'] == 'deliverable'
        assert any('onbekend Type' in w for w in report['warnings'])

    def test_product_met_onbekend_project_id_wordt_overgeslagen(self):
        content = oud_workbook(prod_rows=[['PR1', 'ONBEKEND', '', 'X', 'deliverable', '', 0, '', '', '']],
                                ref_rows=[['P1', 'Project', 'Project 1', '', '', '', '', '', '', '', '', '']])
        _, report, parsed = parse_workbook(content)
        assert parsed['products'] == {}
        assert any('onbekend Project-ID' in w for w in report['warnings'])

    def test_pct_gereed_fractie_en_percentage(self):
        content = oud_workbook(
            ref_rows=[['P1', 'Project', 'Project 1', '', '', '', '', '', '', '', '', '']],
            prod_rows=[
                ['PR1', 'P1', 'Project 1', 'A', 'deliverable', '', 0.5, '', '', ''],
                ['PR2', 'P1', 'Project 1', 'B', 'deliverable', '', 80, '', '', ''],
            ],
        )
        _, _, parsed = parse_workbook(content)
        pct_by_name = {p['name']: p['pctGereed'] for p in parsed['products']['P1']}
        assert pct_by_name == {'A': 50, 'B': 80}


class TestTagsEnOrganisatie:
    def test_tags_en_element_tag_relaties(self):
        content = oud_workbook(
            ref_rows=[['P1', 'Project', 'Project 1', '', '', '', '', '', '', '', '', '']],
            tag_rows=[['T1', 'Tag 1', 'Categorie', '']],
            et_rows=[['P1', 'Project', 'Project 1', 'T1', 'Tag 1', 'Waarom']],
        )
        _, _, parsed = parse_workbook(content)
        assert parsed['tags'] == [{'code': 'T1', 'name': 'Tag 1', 'categorie': 'Categorie', 'omschrijving': ''}]
        assert parsed['elementTags'] == {'P1': ['T1']}

    def test_element_tag_relatie_met_onbekende_tag_wordt_overgeslagen(self):
        content = oud_workbook(
            ref_rows=[['P1', 'Project', 'Project 1', '', '', '', '', '', '', '', '', '']],
            et_rows=[['P1', 'Project', 'Project 1', 'ONBEKEND', '', '']],
        )
        _, report, parsed = parse_workbook(content)
        assert parsed['elementTags'] == {}
        assert any('onbekende Tag-ID' in w for w in report['warnings'])

    def test_organisatieonderdelen_en_ob_organisatie_relaties(self):
        content = oud_workbook(
            ref_rows=[['OB1', 'Operationele benefit', 'OB 1', '', '', '', '', '', '', '', '', '']],
            org_rows=[['O1', 'Org-unit 1', '']],
            obo_rows=[['OB1', 'OB 1', 'O1', 'Org-unit 1', 'Primair', '', 'Gevalideerd']],
        )
        _, _, parsed = parse_workbook(content)
        assert parsed['orgUnits'] == [{'code': 'O1', 'name': 'Org-unit 1', 'omschrijving': ''}]
        assert parsed['obOrg']['OB1'][0]['status'] == 'Gevalideerd'

    def test_ob_organisatie_relatie_hulpkolommenrij_zonder_ids_wordt_overgeslagen(self):
        content = oud_workbook(
            ref_rows=[['OB1', 'Operationele benefit', 'OB 1', '', '', '', '', '', '', '', '', '']],
            org_rows=[['O1', 'Org-unit 1', '']],
            obo_rows=[[None, None, None, None, 'Primair', '', '']],
        )
        _, _, parsed = parse_workbook(content)
        assert parsed['obOrg'] == {}

    def test_onbekende_status_valt_terug_op_concept(self):
        content = oud_workbook(
            ref_rows=[['OB1', 'Operationele benefit', 'OB 1', '', '', '', '', '', '', '', '', '']],
            org_rows=[['O1', 'Org-unit 1', '']],
            obo_rows=[['OB1', 'OB 1', 'O1', 'Org-unit 1', 'Primair', '', 'Niet-bestaande status']],
        )
        _, report, parsed = parse_workbook(content)
        assert parsed['obOrg']['OB1'][0]['status'] == 'Concept'
        assert any('onbekende Status' in w for w in report['warnings'])


class TestProjectstatus:
    def test_referentietabel_heeft_voorrang_boven_projecten_tab(self):
        content = oud_workbook(
            ref_rows=[['P1', 'Project', 'Project 1', '', '', '', '', '', 'Actief', 'Groen', '', '']],
            proj_rows=[['P1', 'Project 1', '', 'Backlog', 'Rood', '', '', '']],
        )
        _, _, parsed = parse_workbook(content)
        assert parsed['projectStatus']['P1']['projectstatus'] == 'Actief'
        assert parsed['projectStatus']['P1']['rag'] == 'Groen'

    def test_projecten_tab_is_fallback_als_referentietabel_leeg_is(self):
        content = oud_workbook(
            ref_rows=[['P1', 'Project', 'Project 1', '', '', '', '', '', '', '', '', '']],
            proj_rows=[['P1', 'Project 1', 'Cluster X', 'Gereed', 'Groen', 'Klaar', '2026-01-15', '']],
        )
        _, _, parsed = parse_workbook(content)
        assert parsed['projectStatus']['P1']['projectstatus'] == 'Gereed'
        assert parsed['projectStatus']['P1']['clusterPpt'] == 'Cluster X'

    def test_onbekende_projectstatus_en_rag_worden_leeggelaten_met_warning(self):
        content = oud_workbook(
            ref_rows=[['P1', 'Project', 'Project 1', '', '', '', '', '', 'Onzin-status', 'Paars', '', '']],
        )
        _, report, parsed = parse_workbook(content)
        assert parsed['projectStatus']['P1']['projectstatus'] == ''
        assert parsed['projectStatus']['P1']['rag'] == ''
        assert any('Onbekende Projectstatus' in w for w in report['warnings'])
        assert any('Onbekende RAG-status' in w for w in report['warnings'])

    def test_projectstatus_normalisatie_hoofdletters(self):
        content = oud_workbook(
            ref_rows=[['P1', 'Project', 'Project 1', '', '', '', '', '', 'on-hold', 'groen', '', '']],
        )
        _, _, parsed = parse_workbook(content)
        assert parsed['projectStatus']['P1']['projectstatus'] == 'On-hold'
        assert parsed['projectStatus']['P1']['rag'] == 'Groen'

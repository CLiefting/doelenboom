"""Tests voor app/tree_pptx.py (DOEL-88) -- bouwt de PowerPoint van een hele
doelenboom en controleert structuur en inhoud door het resultaat weer in te
laden met python-pptx, plus het /tree-pptx-eindpunt in main.py."""
from __future__ import annotations

import io
import re
import zipfile

import pytest
from fastapi.testclient import TestClient
from pptx import Presentation
from pptx.enum.action import PP_ACTION
from pptx.enum.dml import MSO_LINE
from pptx.oxml.ns import qn
from pptx.util import Inches

from app.main import app
from app.project_pptx import CONTENT_W, MARGIN, SLIDE_H
from app.tree_pptx import (
    CHAIN_MAX_ROWS,
    MAX_SLIDES,
    MAX_SLIDES_PER_ELEMENT,
    RIGHT_LEFT,
    TreePptxError,
    _clamp_per_row,
    _Model,
    _paginate_blocks,
    _rgb,
    _text_on,
    _tint,
    build_tree_pptx,
)

client = TestClient(app)
META = {'doelenboom': 'Bewaken en Beveiligen', 'tenant': 'CLPK', 'exportedAt': '2026-10-05T10:00:00Z'}


def col(position, type_name, color='#3E6FA6', label=None, **extra):
    return {
        'position': position, 'typeName': type_name, 'title': extra.pop('title', type_name),
        'subtitle': extra.pop('subtitle', f'Vraag bij {type_name}?'), 'color': color,
        'relationLabelToNext': label, 'aliases': extra.pop('aliases', []),
    }


def el(code, type_name, name=None, **extra):
    return {'code': code, 'type': type_name, 'name': name or f'Naam {code}', 'description': '', 'kpi': '',
            'taakveld': '', 'subtaakveld': '', **extra}


def edge(source, target, weight='primair'):
    return {'source': source, 'target': target, 'weight': weight, 'toelichting': 'GEHEIM-TOELICHTING'}


def make_data():
    """Project -> Capability -> Benefit -> Doel -> Missie."""
    return {
        'columns': [
            col(0, 'Project', '#3E6FA6', 'ontwikkelt'),
            col(1, 'Capability', '#6B4C8A', 'ondersteunt'),
            col(2, 'Benefit', '#C05A2C', 'realiseert'),
            col(3, 'Doel', '#8FAADC', 'geeft invulling aan'),
            col(4, 'Missie', '#203864', None),
        ],
        'elements': [
            el('M1', 'Missie', 'Veilig land'),
            el('D1', 'Doel', 'Betrouwbare beveiliging'),
            el('D2', 'Doel', 'Informatiegestuurd werken'),
            el('B2', 'Benefit', 'Tweede benefit'),
            el('B1', 'Benefit', 'Eerste benefit', description='Regel een.\nRegel twee.', kpi='Reactietijd < 5 min',
               taakveld='Bewaken', subtaakveld='Objecten'),
            el('C1', 'Capability', 'Meldkamer'),
            el('C2', 'Capability', 'Sensoren'),
            el('P1', 'Project', 'Nieuw systeem'),
            el('P2', 'Project', 'Los project'),
        ],
        'edges': [
            edge('D1', 'M1'), edge('D2', 'M1'),
            edge('B1', 'D1'), edge('B1', 'D2', 'ondersteunend'), edge('B2', 'D2'),
            edge('C1', 'B1'), edge('C2', 'B2'),
            edge('P1', 'C1'),
        ],
        'tags': [{'code': 'T1', 'name': 'Digitalisering'}],
        'elementTags': {'B1': ['T1']},
        'orgUnits': [{'code': 'O1', 'name': 'Brigade Noord'}],
        'obOrg': {'B1': [{'org': 'O1', 'relatietype': 'eigenaar'}]},
    }


def load(content: bytes) -> Presentation:
    return Presentation(io.BytesIO(content))


def all_text(slide) -> str:
    return '\n'.join(s.text_frame.text for s in slide.shapes if s.has_text_frame)


def full_text(prs) -> str:
    return '\n'.join(all_text(s) for s in prs.slides)


def shape_names(slide) -> list[str]:
    return [s.name for s in slide.shapes]


def build(options=None, data=None):
    return load(build_tree_pptx(data or make_data(), options or {}, META))


class TestHelpers:
    def test_per_row_wordt_begrensd(self):
        assert _clamp_per_row(4) == 4
        assert _clamp_per_row(1) == 2
        assert _clamp_per_row(99) == 6
        assert _clamp_per_row('3') == 3
        assert _clamp_per_row(None) == 4
        assert _clamp_per_row('veel') == 4
        assert _clamp_per_row({'a': 1}) == 4

    def test_ongeldige_kleur_valt_terug_op_grijs(self):
        assert str(_rgb('#3E6FA6')) == '3E6FA6'
        for bad in (None, '', 'rood', '#12', '#GGGGGG', 123, '"/><script>'):
            assert str(_rgb(bad)) == '6C6F76'

    def test_tekstkleur_past_bij_achtergrond(self):
        assert str(_text_on(_rgb('#203864'))) == 'FFFFFF'
        assert str(_text_on(_rgb('#F4F5F7'))) != 'FFFFFF'

    def test_paginering_verdeelt_lange_tekst_en_kapt_op_het_eind_af(self):
        blocks = [('Beschrijving', ['woord ' * 400])]
        pages = _paginate_blocks(blocks, 40, [5, 10, 10])
        assert len(pages) == 3
        assert pages[0][0] == ('h', 'Beschrijving')
        assert pages[1][0] == ('h', 'Beschrijving (vervolg)')
        assert pages[-1][-1][1].endswith('…')

    def test_paginering_korte_tekst_blijft_op_een_pagina(self):
        pages = _paginate_blocks([('A', ['kort']), ('B', ['ook kort'])], 40, [12, 20])
        assert pages == [[('h', 'A'), ('p', 'kort'), ('h', 'B'), ('p', 'ook kort')]]


class TestSnoerSlide:
    def test_alle_kolommen_met_omschrijving_relatielabel_en_aantal(self):
        prs = build({'perRow': 4})
        text = all_text(prs.slides[0])
        for n, name in enumerate(['Project', 'Capability', 'Benefit', 'Doel', 'Missie'], start=1):
            assert f'{n}. {name}' in text
            assert f'Vraag bij {name}?' in text
        for label in ('ontwikkelt', 'ondersteunt', 'realiseert', 'geeft invulling aan'):
            assert label in text
        assert '2 elementen' in text and '1 element' in text
        assert 'Bewaken en Beveiligen' in text

    def test_zonder_gekozen_kolommen_alleen_de_snoer_slide(self):
        prs = build({})
        assert len(prs.slides) == 1
        assert 'uitgewerkt' not in all_text(prs.slides[0])

    def test_gekozen_kolom_is_gemarkeerd(self):
        text = all_text(build({'slideColumns': ['Benefit']}).slides[0])
        assert '2 elementen · per element uitgewerkt' in text

    def test_slingert_naar_volgende_regel(self):
        """perRow=2 met 5 kolommen: 3 regels; regel 2 loopt van rechts naar
        links, dus kolom 3 staat rechts van kolom 4."""
        slide = build({'perRow': 2}).slides[0]
        boxes = {s.name: s for s in slide.shapes if s.name.startswith('snoer-kolom-')}
        assert len(boxes) == 5
        assert boxes['snoer-kolom-1'].left < boxes['snoer-kolom-2'].left
        assert boxes['snoer-kolom-3'].top > boxes['snoer-kolom-1'].top
        assert boxes['snoer-kolom-3'].left > boxes['snoer-kolom-4'].left
        assert boxes['snoer-kolom-3'].left == boxes['snoer-kolom-2'].left
        assert boxes['snoer-kolom-5'].top > boxes['snoer-kolom-3'].top
        assert boxes['snoer-kolom-5'].left == boxes['snoer-kolom-4'].left

    def test_vakken_blijven_binnen_de_slide(self):
        for per_row in (2, 3, 4, 5, 6):
            prs = build({'perRow': per_row})
            for shape in prs.slides[0].shapes:
                assert shape.left >= 0 and shape.top >= 0
                assert shape.left + shape.width <= prs.slide_width
                assert shape.top + shape.height <= prs.slide_height

    def test_veel_kolommen_lopen_door_op_een_vervolgslide(self):
        data = {'columns': [col(i, f'K{i}') for i in range(11)], 'elements': [], 'edges': []}
        prs = build({'perRow': 2}, data)  # 6 regels -> 2 slides
        assert len(prs.slides) == 2
        assert '8. K7' in all_text(prs.slides[0]) and '9. K8' not in all_text(prs.slides[0])
        assert '9. K8' in all_text(prs.slides[1])
        assert 'VERVOLG' in all_text(prs.slides[1])


class TestVerborgenKolommen:
    OPTIONS = {'visibleColumns': ['Project', 'Benefit', 'Doel', 'Missie'], 'slideColumns': ['Benefit', 'Capability']}

    def test_verborgen_kolom_komt_nergens_voor(self):
        prs = build(self.OPTIONS)
        text = full_text(prs)
        assert 'Capability' not in text
        assert 'Meldkamer' not in text and 'Sensoren' not in text
        assert 'C1' not in text

    def test_verborgen_kolom_krijgt_geen_element_slides_ook_al_is_hij_gekozen(self):
        prs = build(self.OPTIONS)
        # snoer + tussenslide Benefit + B2 + B1
        assert len(prs.slides) == 4

    def test_relatie_wordt_doorgetrokken_over_de_verborgen_kolom(self):
        model = _Model(make_data(), self.OPTIONS)
        assert model.parents['P1'] == {'B1': True}
        assert model.children['B1'] == {'P1': True}
        prs = build(self.OPTIONS)
        b1 = next(s for s in prs.slides if 'B1 — Eerste benefit' in all_text(s))
        assert 'P1  Nieuw systeem' in all_text(b1)
        assert 'verbinding P1' in shape_names(b1)
        assert 'relatie P1 > B1' in shape_names(b1)

    def test_geen_relatielabel_tussen_kolommen_die_geen_buren_zijn(self):
        text = all_text(build(self.OPTIONS).slides[0])
        assert 'ontwikkelt' not in text  # Project -> (verborgen Capability) -> Benefit
        assert 'realiseert' in text

    def test_doorgetrokken_relatie_is_ondersteunend_als_een_schakel_dat_is(self):
        data = make_data()
        data['edges'] = [edge('P1', 'C1', 'ondersteunend'), edge('C1', 'B1')]
        model = _Model(data, self.OPTIONS)
        assert model.parents['P1'] == {'B1': False}

    def test_lege_selectie_van_zichtbare_kolommen_wordt_geweigerd(self):
        with pytest.raises(TreePptxError):
            build_tree_pptx(make_data(), {'visibleColumns': []}, META)
        with pytest.raises(TreePptxError):
            build_tree_pptx(make_data(), {'visibleColumns': ['Bestaat niet']}, META)


class TestElementSlides:
    OPTIONS = {'slideColumns': ['Benefit']}

    def slide_for(self, prs, title):
        return next(s for s in prs.slides if title in all_text(s))

    def test_tussenslide_en_slide_per_element_in_boomvolgorde(self):
        prs = build(self.OPTIONS)
        assert len(prs.slides) == 4
        assert 'KOLOM' in all_text(prs.slides[1]) and 'Benefit' in all_text(prs.slides[1])
        # Boomvolgorde = volgorde van aanleveren: B2 voor B1.
        assert 'B2 — Tweede benefit' in all_text(prs.slides[2])
        assert 'B1 — Eerste benefit' in all_text(prs.slides[3])

    def test_meerdere_kolommen_in_kolomvolgorde(self):
        prs = build({'slideColumns': ['Missie', 'Project']})
        assert 'KOLOM' in all_text(prs.slides[1]) and 'Project' in all_text(prs.slides[1])
        assert 'P1 — Nieuw systeem' in all_text(prs.slides[2])
        assert 'M1 — Veilig land' in all_text(prs.slides[-1])
        assert len(prs.slides) == 1 + (1 + 2) + (1 + 1)

    def test_hele_pad_omhoog_en_omlaag_maar_geen_zijtakken(self):
        slide = self.slide_for(build(self.OPTIONS), 'B1 — Eerste benefit')
        names = shape_names(slide)
        assert 'element B1 (geselecteerd)' in names
        for code in ('P1', 'C1', 'D1', 'D2', 'M1'):
            assert f'element {code}' in names
        # B2, C2 (zijtak via D2) en het losse P2 horen niet in de keten van B1.
        for code in ('B2', 'C2', 'P2'):
            assert f'element {code}' not in names

    def test_ondersteunende_relatie_is_gestippeld(self):
        slide = self.slide_for(build(self.OPTIONS), 'B1 — Eerste benefit')
        lines = {s.name: s for s in slide.shapes if s.name.startswith('relatie ')}
        assert lines['relatie B1 > D2 (ondersteunend)'].line.dash_style == MSO_LINE.DASH
        assert lines['relatie B1 > D1'].line.dash_style is None
        assert 'stippellijn' in all_text(slide)

    def test_tekst_beschrijving_kpi_taakveld_verbindingen_tags_en_org(self):
        text = all_text(self.slide_for(build(self.OPTIONS), 'B1 — Eerste benefit'))
        assert 'BENEFIT · BEWAKEN / OBJECTEN' in text
        assert 'Regel een.' in text and 'Regel twee.' in text
        assert 'Reactietijd < 5 min' in text
        assert 'BOVENLIGGEND (2)' in text
        assert 'D1  Betrouwbare beveiliging' in text
        assert 'D2  Informatiegestuurd werken' in text
        assert 'ONDERLIGGEND (1)' in text
        assert 'C1  Meldkamer' in text
        assert 'Digitalisering' in text
        assert 'Brigade Noord (eigenaar)' in text

    def test_element_zonder_verbindingen(self):
        text = all_text(self.slide_for(build({'slideColumns': ['Project']}), 'P2 — Los project'))
        assert 'Geen verbindingen.' in text
        assert 'Geen beschrijving ingevuld.' in text
        assert 'geen verbindingen met andere zichtbare elementen' in text

    def test_toelichting_bij_relaties_staat_er_niet_in(self):
        assert 'GEHEIM-TOELICHTING' not in full_text(build({'slideColumns': ['Benefit', 'Doel', 'Project']}))

    def test_grote_keten_wordt_per_kolom_begrensd(self):
        data = make_data()
        for i in range(10, 22):
            data['elements'].append(el(f'P{i}', 'Project'))
            data['edges'].append(edge(f'P{i}', 'C1'))
        slide = self.slide_for(build(self.OPTIONS, data), 'B1 — Eerste benefit')
        projects = [n for n in shape_names(slide) if n.startswith('element P')]
        assert len(projects) == CHAIN_MAX_ROWS - 1
        assert f'+ {13 - (CHAIN_MAX_ROWS - 1)} meer' in all_text(slide)

    def test_lange_beschrijving_loopt_door_op_vervolgslide(self):
        data = make_data()
        data['elements'][4]['description'] = 'Lange zin met inhoud. ' * 100
        prs = build(self.OPTIONS, data)
        assert len(prs.slides) == 5
        assert 'VERVOLG' in all_text(prs.slides[4])
        assert 'B1 — Eerste benefit' in all_text(prs.slides[4])

    def test_extreem_lange_tekst_geeft_hooguit_drie_slides_per_element(self):
        data = make_data()
        data['elements'][4]['description'] = 'x' * 200_000
        prs = build(self.OPTIONS, data)
        assert len(prs.slides) == 3 + 3

    def test_alias_type_hoort_bij_de_kolom_en_krijgt_eigen_kleur(self):
        data = make_data()
        data['columns'][2]['aliases'] = [{'typeName': 'Randvoorwaarde', 'color': '#111111'}]
        data['elements'].append(el('R1', 'Randvoorwaarde', 'Een randvoorwaarde'))
        prs = build(self.OPTIONS, data)
        slide = self.slide_for(prs, 'R1 — Een randvoorwaarde')
        assert 'BENEFIT (RANDVOORWAARDE)' in all_text(slide)
        node = next(s for s in slide.shapes if s.name == 'element R1 (geselecteerd)')
        assert str(node.fill.fore_color.rgb) == '111111'

    def test_paginanummers_lopen_door(self):
        prs = build(self.OPTIONS)
        for index, slide in enumerate(prs.slides, start=1):
            assert all_text(slide).rstrip().split('\n')[-1] == str(index)


class TestKlikbareVerbindingen:
    """DOEL-100: beschrijving links op maximaal 1/3, verbindingen rechts als
    blokjes in de kleur van hun kolom, klikbaar naar de eigen slide."""
    OPTIONS = {'slideColumns': ['Benefit', 'Doel']}

    def slide_for(self, prs, title):
        return next(s for s in prs.slides if title in all_text(s))

    def shape(self, slide, name):
        return next(s for s in slide.shapes if s.name == name)

    def test_beschrijving_maximaal_een_derde_en_blokjes_rechts(self):
        slide = self.slide_for(build(self.OPTIONS), 'B1 — Eerste benefit')
        desc = next(s for s in slide.shapes if s.has_text_frame and s.text_frame.text.startswith('BESCHRIJVING'))
        assert desc.width <= CONTENT_W / 3 + 1
        assert desc.left == MARGIN
        for chip in (s for s in slide.shapes if s.name.startswith('verbinding ')):
            assert chip.left >= RIGHT_LEFT
            assert chip.left + chip.width <= MARGIN + CONTENT_W + 1
        # Tags en organisatieonderdelen staan nu links bij de beschrijving.
        assert 'Digitalisering' in desc.text_frame.text and 'Brigade Noord' in desc.text_frame.text

    def test_blokje_in_kolomkleur_en_ondersteunend_gestippeld(self):
        slide = self.slide_for(build(self.OPTIONS), 'B1 — Eerste benefit')
        d1 = self.shape(slide, 'verbinding D1')
        d2 = self.shape(slide, 'verbinding D2 (ondersteunend)')
        c1 = self.shape(slide, 'verbinding C1')
        assert str(d1.line.color.rgb) == '8FAADC' and d1.line.dash_style is None
        assert str(d2.line.color.rgb) == '8FAADC' and d2.line.dash_style == MSO_LINE.DASH
        assert str(c1.line.color.rgb) == '6B4C8A'
        assert str(c1.fill.fore_color.rgb) == str(_tint(_rgb('#6B4C8A'), 0.8))

    def test_blokje_en_ketenvak_springen_naar_de_slide_van_het_element(self):
        prs = build(self.OPTIONS)
        b1 = self.slide_for(prs, 'B1 — Eerste benefit')
        d1_slide = next(s for s in prs.slides if 'D1 — Betrouwbare beveiliging' in all_text(s))
        for name in ('verbinding D1', 'element D1'):
            action = self.shape(b1, name).click_action
            assert action.action == PP_ACTION.NAMED_SLIDE
            assert action.target_slide.slide_id == d1_slide.slide_id
        # En terug: vanaf D1 naar B1 (een eerdere slide).
        back = self.shape(d1_slide, 'verbinding B1').click_action
        assert back.target_slide.slide_id == b1.slide_id

    def test_tooltip_noemt_het_doelelement(self):
        b1 = self.slide_for(build(self.OPTIONS), 'B1 — Eerste benefit')
        link = self.shape(b1, 'verbinding D2 (ondersteunend)')._element.find('.//' + qn('a:hlinkClick'))
        assert link.get('tooltip') == 'Ga naar D2 — Informatiegestuurd werken (ondersteunende relatie)'

    def test_geen_link_naar_element_zonder_eigen_slide(self):
        b1 = self.slide_for(build(self.OPTIONS), 'B1 — Eerste benefit')
        for name in ('verbinding C1', 'element C1', 'element M1', 'element B1 (geselecteerd)'):
            assert self.shape(b1, name).click_action.target_slide is None

    def test_legenda_noemt_klikken_alleen_als_er_links_zijn(self):
        with_links = self.slide_for(build(self.OPTIONS), 'B1 — Eerste benefit')
        assert 'Klik op een element' in all_text(with_links)
        without = self.slide_for(build({'slideColumns': ['Benefit']}), 'B1 — Eerste benefit')
        assert 'Klik op een element' not in all_text(without)

    def many_children(self, n):
        data = make_data()
        for i in range(n):
            data['elements'].append(el(f'X{i}', 'Capability', f'Capability met een redelijk lange naam {i}'))
            data['edges'].append(edge(f'X{i}', 'B1', 'ondersteunend' if i % 3 == 0 else 'primair'))
        return data

    def test_twaalf_verbindingen_passen_op_een_slide_zonder_vervolg(self):
        prs = build({'slideColumns': ['Benefit']}, self.many_children(11))  # + C1 = 12 onderliggend
        assert len(prs.slides) == 4
        slide = self.slide_for(prs, 'B1 — Eerste benefit')
        chips = [s for s in slide.shapes if s.name.startswith('verbinding ')]
        assert len(chips) == 2 + 12
        for chip in chips:
            assert chip.top + chip.height <= SLIDE_H - Inches(0.5)

    def test_heel_veel_verbindingen_lopen_door_en_worden_samengevat(self):
        n = 500
        prs = build({'slideColumns': ['Benefit']}, self.many_children(n))
        b1_slides = [s for s in prs.slides if 'B1 — Eerste benefit' in all_text(s)]
        assert len(b1_slides) == MAX_SLIDES_PER_ELEMENT
        assert 'VERVOLG' in all_text(b1_slides[1])
        shown = sum(1 for s in b1_slides for sh in s.shapes
                    if sh.name.startswith('verbinding ') and sh.name != 'verbinding + meer')
        more = next(sh for sh in b1_slides[-1].shapes if sh.name == 'verbinding + meer')
        hidden = int(re.search(r'\+ (\d+) meer', more.text_frame.text).group(1))
        assert shown + hidden == 2 + n + 1  # 2 boven, n + C1 onder
        for slide in b1_slides:
            for chip in slide.shapes:
                assert chip.top + chip.height <= SLIDE_H

    def test_vervolgslide_zonder_blokjes_gebruikt_de_hele_breedte(self):
        data = make_data()
        data['elements'][4]['description'] = 'Lange zin met inhoud. ' * 100
        prs = build(self.OPTIONS, data)
        vervolg = next(s for s in prs.slides if 'VERVOLG' in all_text(s) and 'B1 — Eerste' in all_text(s))
        body = next(s for s in vervolg.shapes if s.has_text_frame and 'BESCHRIJVING (VERVOLG)' in s.text_frame.text)
        assert body.width == CONTENT_W

    def test_owasp_a03_namen_in_blokjes_en_tooltips_blijven_letterlijk(self):
        data = make_data()
        evil = '"/><a:hlinkClick action="ppaction://program" r:id="x"/> <script>&'
        data['elements'][1]['name'] = evil  # D1
        prs = build(self.OPTIONS, data)
        b1 = self.slide_for(prs, 'B1 — Eerste benefit')
        chip = self.shape(b1, 'verbinding D1')
        assert evil[:20] in chip.text_frame.text
        link = chip._element.find('.//' + qn('a:hlinkClick'))
        assert link.get('action') == 'ppaction://hlinksldjump'
        assert evil in link.get('tooltip')
        # Er komt nergens een extra (geinjecteerde) actie bij.
        for slide in prs.slides:
            for h in slide._element.iter(qn('a:hlinkClick')):
                assert h.get('action') == 'ppaction://hlinksldjump'

    def test_owasp_geen_externe_links_in_het_pakket(self):
        data = make_data()
        data['elements'][1]['name'] = 'https://evil.example/phish'
        content = build_tree_pptx(data, self.OPTIONS, META)
        with zipfile.ZipFile(io.BytesIO(content)) as z:
            for name in z.namelist():
                if name.endswith('.rels'):
                    rels = z.read(name).decode()
                    assert 'TargetMode="External"' not in rels
                    assert 'evil.example' not in rels


class TestRobuustheid:
    """Vijandige of kapotte invoer mag de service niet laten crashen en geen
    ongeldig bestand opleveren (OWASP A03/A04)."""

    def test_cyclus_in_relaties_loopt_niet_vast(self):
        data = make_data()
        data['edges'] += [edge('M1', 'P1'), edge('D1', 'B1'), edge('B1', 'B1')]
        prs = build({'slideColumns': ['Benefit', 'Project', 'Missie']}, data)
        assert len(prs.slides) > 4

    def test_cyclus_door_verborgen_kolom_loopt_niet_vast(self):
        data = make_data()
        data['elements'].append(el('C3', 'Capability'))
        data['edges'] += [edge('C1', 'C3'), edge('C3', 'C1'), edge('C3', 'B2', 'ondersteunend')]
        model = _Model(data, {'visibleColumns': ['Project', 'Benefit']})
        assert model.parents['P1'] == {'B1': True, 'B2': False}

    def test_hele_diepe_keten_geeft_geen_recursiefout(self):
        n = 3000
        data = {
            'columns': [col(0, 'A'), col(1, 'Verborgen'), col(2, 'Z')],
            'elements': [el('A1', 'A'), el('Z1', 'Z')] + [el(f'H{i}', 'Verborgen') for i in range(n)],
            'edges': [edge('A1', 'H0'), edge(f'H{n - 1}', 'Z1')] + [edge(f'H{i}', f'H{i + 1}') for i in range(n - 1)],
        }
        model = _Model(data, {'visibleColumns': ['A', 'Z']})
        assert model.parents['A1'] == {'Z1': True}

    def test_xml_en_besturingstekens_in_tekst(self):
        data = make_data()
        data['elements'][4].update(
            name='<script>alert(1)</script> & "quotes"', description='Nul\x00byte \x0b en ]]> <a:t>inject</a:t>')
        data['columns'][2]['title'] = 'Benefit</a:t><evil/>'
        prs = build({'slideColumns': ['Benefit']}, data)
        text = full_text(prs)
        assert '<script>alert(1)</script> & "quotes"' in text
        assert 'Nulbyte' in text and '<a:t>inject</a:t>' in text
        assert '\x00' not in text

    def test_formule_achtige_tekst_blijft_letterlijke_tekst(self):
        data = make_data()
        data['elements'][4]['name'] = '=HYPERLINK("http://evil","klik")'
        prs = build({'slideColumns': ['Benefit']}, data)
        assert '=HYPERLINK("http://evil","klik")' in full_text(prs)
        for slide in prs.slides:
            for shape in slide.shapes:
                # Alleen interne sprongen naar een slide (DOEL-100), nooit een
                # (externe) hyperlink-adres uit de invoer.
                address = shape.click_action.hyperlink.address
                assert not address or re.fullmatch(r'slide\d+\.xml', address)
                if shape.has_text_frame:
                    for p in shape.text_frame.paragraphs:
                        for run in p.runs:
                            assert run.hyperlink.address is None

    def test_verkeerde_types_in_de_invoer(self):
        data = {
            'columns': [col(0, 'A'), 'geen dict', {'typeName': None}, {'typeName': 'B', 'color': 5, 'aliases': 'x', 'position': 'nee'}],
            'elements': [el('A1', 'A'), None, 7, {'code': None}, {'code': 'A1', 'type': 'A'}, {'code': 'X', 'type': ['A']}],
            'edges': [None, 'x', {'source': 'A1'}, {'source': 'A1', 'target': 'BESTAAT-NIET'}, {'source': 1, 'target': 2}],
            'tags': 'geen lijst', 'elementTags': ['geen dict'], 'orgUnits': None, 'obOrg': {'A1': 'geen lijst'},
        }
        prs = load(build_tree_pptx(data, {'slideColumns': ['A', 5, None], 'visibleColumns': 'alles', 'perRow': []}, 'geen meta'))
        assert len(prs.slides) == 3

    def test_lege_of_ontbrekende_invoer(self):
        for data in (None, {}, [], 'tekst', {'columns': []}):
            with pytest.raises(TreePptxError):
                build_tree_pptx(data, None, None)

    def test_te_veel_slides_wordt_geweigerd_met_duidelijke_melding(self):
        data = {'columns': [col(0, 'A')], 'elements': [el(f'A{i}', 'A') for i in range(MAX_SLIDES)], 'edges': []}
        with pytest.raises(TreePptxError) as exc:
            build_tree_pptx(data, {'slideColumns': ['A']}, META)
        assert str(MAX_SLIDES) in str(exc.value)
        # Zonder element-slides mag dezelfde grote boom wel.
        assert len(build({}, data).slides) == 1

    def test_precies_op_de_grens_mag(self):
        data = {'columns': [col(0, 'A')], 'elements': [el(f'A{i}', 'A') for i in range(MAX_SLIDES - 2)], 'edges': []}
        assert len(build({'slideColumns': ['A']}, data).slides) == MAX_SLIDES


class TestEndpoint:
    def test_geeft_een_pptx_terug(self):
        res = client.post('/tree-pptx', json={'data': make_data(), 'options': {'slideColumns': ['Doel']}, 'meta': META})
        assert res.status_code == 200
        assert res.headers['content-type'] == (
            'application/vnd.openxmlformats-officedocument.presentationml.presentation')
        assert res.content[:2] == b'PK'
        assert len(load(res.content).slides) == 4

    def test_ongeldige_keuze_geeft_422_met_melding(self):
        res = client.post('/tree-pptx', json={'data': make_data(), 'options': {'visibleColumns': []}, 'meta': META})
        assert res.status_code == 422
        assert 'zichtbare kolom' in res.json()['error']

    def test_lege_body_geeft_422_en_geen_500(self):
        res = client.post('/tree-pptx', json={})
        assert res.status_code == 422
        assert 'error' in res.json()

    def test_foutmelding_lekt_geen_interne_details(self):
        res = client.post('/tree-pptx', json={'data': {'columns': 'kapot'}})
        assert res.status_code == 422
        assert 'Traceback' not in res.text and 'tree_pptx.py' not in res.text

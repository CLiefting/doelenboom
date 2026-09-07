"""Tests voor app/project_pptx.py -- bouwt de Project-PowerPoint-rapportage
voor één project en controleert de (dynamische) slide-structuur/inhoud door
het resultaat weer in te laden met python-pptx zelf."""
from __future__ import annotations

import io

from pptx import Presentation

from app.project_pptx import (
    _build_timeline_markers,
    _fmt_date,
    _month_range_label,
    _paginate,
    _truncate,
    build_project_pptx,
)

from .test_project_workbook import make_data, make_meta


def all_text(slide) -> str:
    parts = []
    for shape in slide.shapes:
        if shape.has_text_frame:
            parts.append(shape.text_frame.text)
        if shape.has_table:
            for row in shape.table.rows:
                for cell in row.cells:
                    parts.append(cell.text)
    return '\n'.join(parts)


def full_text(prs: Presentation) -> str:
    return '\n'.join(all_text(s) for s in prs.slides)


class TestFmtDate:
    def test_geldige_datum(self):
        assert _fmt_date('2026-09-15') == '15 sep 2026'

    def test_leeg_of_none(self):
        assert _fmt_date(None) == '-'
        assert _fmt_date('') == '-'

    def test_onherkenbare_waarde_blijft_zichtbaar(self):
        assert _fmt_date('onzin') == 'onzin'


class TestTruncate:
    def test_korte_tekst_blijft_ongewijzigd(self):
        assert _truncate('kort', 10) == 'kort'

    def test_lange_tekst_wordt_afgekapt_met_ellipsis(self):
        result = _truncate('a' * 20, 10)
        assert len(result) == 10
        assert result.endswith('…')


class TestPaginate:
    def test_lege_lijst_geeft_lege_lijst(self):
        assert _paginate([], 5) == []

    def test_deelt_op_in_stukken(self):
        assert _paginate(list(range(7)), 3) == [[0, 1, 2], [3, 4, 5], [6]]


class TestMonthRangeLabel:
    def test_zelfde_jaar(self):
        from datetime import date
        assert _month_range_label(date(2026, 9, 1), date(2026, 10, 1)) == 'Sep – Okt 2026'

    def test_jaarwisseling(self):
        from datetime import date
        assert _month_range_label(date(2026, 12, 1), date(2027, 1, 1)) == 'Dec 2026 – Jan 2027'


class TestBuildTimelineMarkers:
    """Spiegelt de tijdlijn-toggle 'Geplande datum bij opgeleverde items' uit
    tree.html (showPlannedForDelivered): standaard (True) blijft de
    geplande/verwachte datum altijd naast een eventuele werkelijke datum
    staan; uitgezet vervalt de geplande datum zodra er ook een werkelijke
    datum is, maar blijft die leidend zolang er nog geen werkelijke datum
    is."""

    def _product(self, **overrides):
        base = {
            'type': 'deliverable', 'verwachteDatum': '2026-09-15',
            'werkelijkeDatum': '2026-09-10', 'deadline': None,
        }
        base.update(overrides)
        return base

    def test_standaard_toont_geplande_en_werkelijke_datum_naast_elkaar(self):
        # markers zijn op datum gesorteerd (werkelijk 10 sep vóór verwacht 15
        # sep), dus op 'filled' checken i.p.v. op volgorde.
        markers = _build_timeline_markers([self._product()])
        assert len(markers) == 2
        assert {m['filled'] for m in markers} == {True, False}

    def test_uitgezet_en_al_werkelijke_datum_laat_alleen_werkelijke_marker_staan(self):
        markers = _build_timeline_markers([self._product()], show_planned_for_delivered=False)
        assert len(markers) == 1
        assert markers[0]['filled']

    def test_uitgezet_zonder_werkelijke_datum_blijft_geplande_datum_leidend(self):
        markers = _build_timeline_markers(
            [self._product(werkelijkeDatum=None)], show_planned_for_delivered=False,
        )
        assert len(markers) == 1
        assert not markers[0]['filled']

    def test_deadline_blijft_altijd_los_van_de_toggle(self):
        markers = _build_timeline_markers(
            [self._product(deadline='2026-10-01')], show_planned_for_delivered=False,
        )
        assert any(m['is_deadline'] for m in markers)


class TestBuildProjectPptx:
    def test_slide_1_toont_projectnaam_code_status_en_tijdlijn(self):
        content = build_project_pptx(make_data(), make_meta())
        prs = Presentation(io.BytesIO(content))
        text = all_text(prs.slides[0])
        assert 'Sweepen' in text
        assert 'NP37' in text
        assert 'Groen' in text  # RAG-label, title-cased vanaf 'groen'
        assert 'actief' in text.lower()  # fixture levert lowercase 'actief'
        # Aandachtspunten (voorheen losse slide) staan nu ook op slide 1.
        assert 'Op schema' in text
        assert 'IGO' in text
        assert 'HRB-S' in text
        # Projecttijdlijn: make_data()'s producten hebben allemaal een
        # verwachte/werkelijke datum of deadline, dus hoort de tijdlijn (as +
        # 'vandaag'-lijn + legenda) getekend te worden.
        assert 'vandaag' in text
        assert 'Deliverable · verwacht' in text
        assert 'Mijlpaal · gehaald' in text
        assert 'Deadline' in text

    def test_toggle_showplannedfordelivered_uit_toont_minder_tijdlijnmarkers(self):
        # PID (make_data()) heeft zowel een verwachte als een werkelijke
        # datum -- met de toggle uit hoort de geplande-datummarker daarvan te
        # vervallen, dus minder tekenvormen op de tijdlijn dan met de toggle
        # aan (het aantal shapes op de slide is de enige praktische manier om
        # dit via de gerenderde PPTX zelf te controleren; de exacte
        # markerlogica zelf wordt al gedekt door TestBuildTimelineMarkers).
        meta_aan = make_meta()
        meta_aan['showPlannedForDelivered'] = True
        meta_uit = make_meta()
        meta_uit['showPlannedForDelivered'] = False
        prs_aan = Presentation(io.BytesIO(build_project_pptx(make_data(), meta_aan)))
        prs_uit = Presentation(io.BytesIO(build_project_pptx(make_data(), meta_uit)))
        n_aan = len(prs_aan.slides[0].shapes)
        n_uit = len(prs_uit.slides[0].shapes)
        assert n_uit < n_aan

    def test_toggle_ontbreekt_in_meta_gedraagt_zich_als_aan(self):
        # Geen showPlannedForDelivered in meta (bv. oudere clients) -- moet
        # zich hetzelfde gedragen als expliciet True, niet als False.
        meta_zonder = make_meta()
        meta_expliciet_aan = make_meta()
        meta_expliciet_aan['showPlannedForDelivered'] = True
        prs_zonder = Presentation(io.BytesIO(build_project_pptx(make_data(), meta_zonder)))
        prs_aan = Presentation(io.BytesIO(build_project_pptx(make_data(), meta_expliciet_aan)))
        assert len(prs_zonder.slides[0].shapes) == len(prs_aan.slides[0].shapes)

    def test_geen_gedateerde_producten_geeft_geen_tijdlijn_op_slide_1(self):
        data = make_data()
        for p in data['products']:
            p['verwachteDatum'] = None
            p['werkelijkeDatum'] = None
            p['deadline'] = None
        content = build_project_pptx(data, make_meta())
        prs = Presentation(io.BytesIO(content))
        text = all_text(prs.slides[0])
        assert 'vandaag' not in text
        # Aandachtspunten moeten dan gewoon een stuk omhoog geschoven zijn,
        # niet verdwijnen.
        assert 'Op schema' in text

    def test_openstaande_deliverables_tabel_bevat_alleen_niet_opgeleverde(self):
        content = build_project_pptx(make_data(), make_meta())
        prs = Presentation(io.BytesIO(content))
        text = all_text(prs.slides[1])
        # Adviesrapport en GO/NO-GO zijn nog niet opgeleverd (geen
        # werkelijkeDatum); PID is al opgeleverd en hoort hier niet meer bij.
        assert 'Adviesrapport' in text
        assert 'GO/NO-GO' in text
        assert 'PID' not in text
        assert 'Openstaande deliverables' in text

    def test_alle_openstaande_deliverables_worden_getoond_over_meerdere_slides(self):
        # Vroeger werd dit afgekapt tot een top-6 met "+N meer" -- nu horen
        # ALLE openstaande deliverables ergens in de presentatie te staan,
        # desnoods over meerdere gepagineerde slides.
        data = make_data()
        data['products'] = [
            {
                'id': i, 'name': f'D{i}', 'type': 'deliverable', 'pctGereed': 0,
                'verwachteDatum': f'2026-09-{(i % 27) + 1:02d}', 'werkelijkeDatum': None,
                'businessValue': None, 'omschrijving': '', 'deadline': None, 'duur': None,
                'duurEenheid': 'd', 'opmerking': '',
            }
            for i in range(1, 26)
        ]
        content = build_project_pptx(data, make_meta())
        prs = Presentation(io.BytesIO(content))
        text = full_text(prs)
        for i in range(1, 26):
            assert f'D{i}' in text
        assert '+ ' not in text or 'andere' not in text  # geen "+N meer"-teller meer

    def test_gepland_komende_2_maanden_slide_toont_alleen_deliverables_in_die_periode(self):
        data = make_data()
        meta = make_meta()
        meta['exportedAt'] = '2026-08-27T19:00:00Z'  # 'vandaag' = 27 aug 2026
        content = build_project_pptx(data, meta)
        prs = Presentation(io.BytesIO(content))
        # Adviesrapport (2026-08-29) valt in aug/sep 2026 -> hoort erbij.
        # GO/NO-GO (2027-04-01) valt daar ver buiten -> hoort er niet bij.
        gepland_slide = next(s for s in prs.slides if 'komende 2 maanden' in all_text(s))
        text = all_text(gepland_slide)
        assert 'Adviesrapport' in text
        assert 'GO/NO-GO' not in text

    def test_deliverables_als_tiles_toont_badges_en_scheiding_open_opgeleverd(self):
        content = build_project_pptx(make_data(), make_meta())
        prs = Presentation(io.BytesIO(content))
        tile_slides = [s for s in prs.slides if 'Deliverables' in all_text(s) and 'gereed' in all_text(s)]
        assert tile_slides
        combined = '\n'.join(all_text(s) for s in tile_slides)
        assert 'Adviesrapport' in combined
        assert 'PID' in combined
        assert 'gereed' in combined  # voortgangspercentage op de tile
        assert 'Opgeleverd / gehaald' in combined

    def test_activiteiten_gantt_toont_ook_deliverables_met_duur_en_afhankelijkheid(self):
        # make_data(): 'Adviesrapport' heeft een ingevulde duur (10 maanden)
        # -> hoort als doorlooptijd-balkje op de Activiteiten-Gantt te staan,
        # net als op het scherm (activityGanttHtml in tree.html). 'PID' en
        # 'GO/NO-GO' hebben geen duur, maar zitten wel in een
        # productDependency -> horen als "lite" rij met afhankelijkheid-
        # badge te verschijnen, ook al hebben ze zelf geen balkje.
        content = build_project_pptx(make_data(), make_meta())
        prs = Presentation(io.BytesIO(content))
        gantt_slides = [s for s in prs.slides if all_text(s).startswith('PLANNING\nActiviteiten')]
        text = '\n'.join(all_text(s) for s in gantt_slides)
        assert 'Adviesrapport' in text
        assert 'PID' in text
        assert 'GO/NO-GO' in text
        assert 'deliverable(s) met doorlooptijd/afhankelijkheid' in text
        # Eén van beide badge-varianten moet zijn getekend (afhankelijk van
        # of de testdata toevallig een planningsconflict oplevert of niet).
        assert ('🔗' in text) or ('⚠' in text)

    def test_activiteiten_gantt_toont_alle_activiteiten_en_vandaag_lijn(self):
        content = build_project_pptx(make_data(), make_meta())
        prs = Presentation(io.BytesIO(content))
        gantt_slide = next(s for s in prs.slides if all_text(s).startswith('PLANNING\nActiviteiten'))
        text = all_text(gantt_slide)
        assert 'Taak A' in text
        assert 'Taak B' in text
        assert 'vandaag' in text

    def test_veel_activiteiten_pagineert_over_meerdere_gantt_slides(self):
        data = make_data()
        data['activities'] = [
            {
                'id': 100 + i, 'name': f'Taak {i}', 'startDate': f'2026-{(i % 12) + 1:02d}-01',
                'endDate': f'2026-{(i % 12) + 1:02d}-10', 'omschrijving': '', 'isMilestone': False, 'isSummary': False,
            }
            for i in range(1, 25)
        ]
        content = build_project_pptx(data, make_meta())
        prs = Presentation(io.BytesIO(content))
        gantt_slides = [s for s in prs.slides if all_text(s).startswith('PLANNING\nActiviteiten')]
        assert len(gantt_slides) > 1
        combined = '\n'.join(all_text(s) for s in gantt_slides)
        for i in range(1, 25):
            assert f'Taak {i}' in combined

    def test_lege_data_crasht_niet(self):
        content = build_project_pptx({}, {})
        prs = Presentation(io.BytesIO(content))
        assert len(prs.slides) >= 1
        assert 'Project' in all_text(prs.slides[0])

    def test_geen_deliverables_en_geen_activiteiten_toont_lege_staat_meldingen(self):
        data = {'project': make_data()['project'], 'products': [], 'activities': []}
        content = build_project_pptx(data, make_meta())
        prs = Presentation(io.BytesIO(content))
        text = full_text(prs)
        assert 'Nog geen deliverables vastgelegd voor dit project.' in text
        assert 'Nog geen activiteiten of deliverables met een doorlooptijd vastgelegd voor dit project.' in text

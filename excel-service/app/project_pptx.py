"""
Export van de gegevens van ÉÉN project (Project-element) als PowerPoint-
presentatie, bedoeld als kant-en-klare rapportage voor een klant/externe
stakeholder buiten de applicatie. Hergebruikt exact dezelfde 'data'/'meta'-
vorm als build_project_workbook() in project_workbook.py hiernaast (zie de
toelichting daar, en api/src/routes/projectExcel.ts::buildProjectExportData
voor waar die JSON vandaan komt) -- alleen de output is hier een .pptx
i.p.v. een .xlsx.

Puur een export, geen import/round-trip: dit is een leesbaar eindresultaat,
geen brondocument om later weer in te lezen (in tegenstelling tot het
Excel-formaat hiernaast).

Slide-structuur (aantal slides is dynamisch -- de lijst-/tile-/Gantt-
secties pagineren over zoveel slides als nodig, zie _paginate hieronder):
  1.  Overzicht -- status/RAG/projectstatus, projecttijdlijn en
      aandachtspunten (toelichting/tags/organisatieonderdelen/cluster) samen
      op één slide (voorheen losse status- en aandachtspunten-slides).
  2+. Openstaande deliverables -- ALLE nog niet opgeleverde deliverables/
      mijlpalen als tabel, niet langer afgekapt tot een top-6 met "+N meer".
  N+1 Gepland -- komende 2 maanden -- subset van bovenstaande met een
      verwachte datum in de huidige of eerstvolgende kalendermaand (alleen
      deliverables, geen activiteiten -- zo afgesproken).
  N+2+ Deliverables als tiles -- alle producten in dezelfde kaartvorm als
      de projectkaart in de app (productCardHtml in tree.html), open eerst,
      dan een aparte sectie "Opgeleverd / gehaald".
  Laatste Activiteiten -- horizontale tijdsbalken per activiteit op een
      gedeelde datum-as (vervangt de eerdere 3-kolommen bullet-lijst).

Aangeroepen door api/src/routes/projectExcel.ts (POST .../project-pptx).
"""
from __future__ import annotations

import io
from datetime import date, timedelta
from typing import Any

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.dml import MSO_PATTERN_TYPE
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt

# Zelfde RAG-kleuren als RAG_COLORS in web/public/tree.html, voor visuele
# consistentie tussen de app zelf en dit gegenereerde document.
RAG_COLORS = {
    'rood': RGBColor(0xDC, 0x35, 0x45),
    'oranje': RGBColor(0xFD, 0x7E, 0x14),
    'groen': RGBColor(0x28, 0xA7, 0x45),
}
RAG_DEFAULT_COLOR = RGBColor(0xB5, 0xBA, 0xC2)

DARK = RGBColor(0x1F, 0x29, 0x37)
MUTED = RGBColor(0x6C, 0x6F, 0x76)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
LIGHT_BG = RGBColor(0xF4, 0xF5, 0xF7)
ACCENT = RGBColor(0x2F, 0x55, 0x97)  # zelfde blauw als de "Strategisch doel"-kolom elders in de app

SLIDE_W = Inches(13.333)
SLIDE_H = Inches(7.5)
MARGIN = Inches(0.6)
CONTENT_W = SLIDE_W - 2 * MARGIN

MAANDEN_KORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']

# Paginering: elke lijst-/tile-/Gantt-sectie hieronder loopt over zoveel
# slides als nodig (zie _paginate) i.p.v. eerder een vaste top-N met "+N
# meer" -- deze constanten bepalen puur hoeveel er per slide past, geen
# inhoudelijke limiet.
DELIVERABLES_ROWS_PER_SLIDE = 11
TILE_COLS = 3
TILE_ROWS_PER_SLIDE = 3
TILES_PER_SLIDE = TILE_COLS * TILE_ROWS_PER_SLIDE
GANTT_ROWS_PER_SLIDE = 9


def _fmt_date(value: Any) -> str:
    """'2026-09-15' -> '15 sep 2026'; None/leeg/onherkenbaar -> '-'."""
    if not value:
        return '-'
    s = str(value)[:10]
    try:
        y, m, d = (int(part) for part in s.split('-'))
        return f'{d} {MAANDEN_KORT[m - 1]} {y}'
    except (ValueError, IndexError):
        return s


def _today_iso(meta: dict[str, Any]) -> str:
    # 'Vandaag' voor het indelen van deliverables/activiteiten in
    # openstaand/gepland/lopend -- meta.exportedAt (het moment van
    # genereren) is hier leidend i.p.v. de servertijd zelf, zodat een
    # handmatig later gedraaide her-export met een meegegeven exportedAt
    # reproduceerbaar blijft.
    exported_at = meta.get('exportedAt')
    if isinstance(exported_at, str) and exported_at:
        return exported_at[:10]
    return date.today().isoformat()


def _pct(value: Any) -> int:
    try:
        return max(0, min(100, int(value)))
    except (TypeError, ValueError):
        return 0


def _num(value: Any) -> float | None:
    if value is None or value == '':
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _truncate(text: str, max_len: int) -> str:
    text = text.strip()
    return text if len(text) <= max_len else text[: max_len - 1].rstrip() + '…'


def _paginate(items: list[Any], size: int) -> list[list[Any]]:
    """Deelt items op in aaneengesloten stukken van maximaal `size` -- lege
    lijst geeft lege lijst terug (dus GEEN losse slide met alleen een
    lege-staat-melding; de aanroeper beslist zelf of zo'n slide gewenst is)."""
    if not items:
        return []
    return [items[i:i + size] for i in range(0, len(items), size)]


def _new_presentation() -> Presentation:
    prs = Presentation()
    prs.slide_width = SLIDE_W
    prs.slide_height = SLIDE_H
    return prs


def _blank_slide(prs: Presentation):
    return prs.slides.add_slide(prs.slide_layouts[6])  # 6 = volledig leeg layout


def _add_rect(slide, left, top, width, height, fill: RGBColor | None, line: bool = False):
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, width, height)
    shape.shadow.inherit = False
    if fill is None:
        shape.fill.background()
    else:
        shape.fill.solid()
        shape.fill.fore_color.rgb = fill
    if line:
        shape.line.color.rgb = RGBColor(0xE0, 0xE2, 0xE6)
        shape.line.width = Pt(0.75)
    else:
        shape.line.fill.background()
    return shape


def _add_text(
    slide, left, top, width, height, text: str, *, size: int, bold: bool = False,
    color: RGBColor = DARK, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, wrap: bool = True,
):
    box = slide.shapes.add_textbox(left, top, width, height)
    tf = box.text_frame
    tf.word_wrap = wrap
    tf.vertical_anchor = anchor
    tf.margin_left = 0
    tf.margin_right = 0
    tf.margin_top = 0
    tf.margin_bottom = 0
    p = tf.paragraphs[0]
    p.alignment = align
    run = p.add_run()
    run.text = text
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color
    run.font.name = 'Calibri'
    return box


def _add_badge(slide, left, top, text: str, *, bg: RGBColor, fg: RGBColor = WHITE, h=Inches(0.22)):
    """Klein gekleurd label (bv. 'Mijlpaal', 'Te laat', 'BV 100'), zoals de
    badges bovenaan een projectkaart in de app (productCardHtml in
    tree.html). Breedte wordt geschat op tekstlengte; geeft de x-positie
    terug waar het volgende badge kan beginnen, zodat badges op een rij
    gestapeld kunnen worden."""
    w = int(Inches(0.1)) * len(text) + int(Inches(0.24))
    shape = _add_rect(slide, left, top, w, h, bg)
    tf = shape.text_frame
    tf.margin_left = 0
    tf.margin_right = 0
    tf.margin_top = 0
    tf.margin_bottom = 0
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run = p.add_run()
    run.text = text
    run.font.size = Pt(8)
    run.font.bold = True
    run.font.color.rgb = fg
    run.font.name = 'Calibri'
    return left + w + int(Inches(0.08))


def _slide_header(slide, kicker: str, title: str):
    _add_text(slide, MARGIN, Inches(0.45), CONTENT_W, Inches(0.3), kicker.upper(), size=12, bold=True, color=ACCENT)
    _add_text(slide, MARGIN, Inches(0.75), CONTENT_W, Inches(0.6), title, size=26, bold=True, color=DARK)
    _add_rect(slide, MARGIN, Inches(1.35), CONTENT_W, Emu(1), MUTED)


def _footer(slide, project: dict[str, Any], meta: dict[str, Any], page: int):
    text = (
        f"{project.get('name', '')} ({project.get('code', '')}) — "
        f"{meta.get('doelenboom', '')} / {meta.get('tenant', '')}"
    )
    _add_text(slide, MARGIN, SLIDE_H - Inches(0.4), CONTENT_W - Inches(0.6), Inches(0.3), text, size=9, color=MUTED)
    _add_text(
        slide, SLIDE_W - MARGIN - Inches(0.6), SLIDE_H - Inches(0.4), Inches(0.6), Inches(0.3),
        str(page), size=9, color=MUTED, align=PP_ALIGN.RIGHT,
    )


def _rag_color(rag: str | None) -> RGBColor:
    return RAG_COLORS.get((rag or '').strip().lower(), RAG_DEFAULT_COLOR)


# ---- Projecttijdlijn (verwachte/werkelijke opleverdatum + deadline per
# product, op één gezamenlijke maand-/kwartaalas) -- hetzelfde concept als
# productTimelineHtml/buildTimelineMarkers/timelineBandBoundaries in
# web/public/tree.html, hier eenmalig gerenderd als vaste tekening i.p.v.
# interactieve HTML (geen hover-tooltips dus, alleen de as/markers/legenda).

TIMELINE_MARKER_COLOR = RGBColor(0x2F, 0x55, 0x97)  # zelfde blauw als timelineLegendIcon in tree.html
TIMELINE_DEADLINE_COLOR = RGBColor(0xB4, 0x23, 0x18)  # zelfde rood als timelineDeadlineIcon in tree.html
TIMELINE_AXIS_COLOR = RGBColor(0xC7, 0xCB, 0xD1)


def _parse_iso_date(value: Any) -> date | None:
    if not value:
        return None
    s = str(value)[:10]
    try:
        y, m, d = (int(part) for part in s.split('-'))
        return date(y, m, d)
    except (ValueError, IndexError):
        return None


def _build_timeline_markers(products: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Zelfde opzet als buildTimelineMarkers() in tree.html: per product een
    marker voor de verwachte datum, de werkelijke (opgeleverde) datum en de
    deadline -- elk optioneel, een product kan dus 0 tot 3 markers leveren."""
    markers: list[dict[str, Any]] = []
    for p in products:
        marker_type = 'mijlpaal' if p.get('type') == 'mijlpaal' else 'deliverable'
        verwacht = _parse_iso_date(p.get('verwachteDatum'))
        if verwacht:
            markers.append({'t': verwacht, 'type': marker_type, 'filled': False, 'is_deadline': False})
        werkelijk = _parse_iso_date(p.get('werkelijkeDatum'))
        if werkelijk:
            markers.append({'t': werkelijk, 'type': marker_type, 'filled': True, 'is_deadline': False})
        deadline = _parse_iso_date(p.get('deadline'))
        if deadline:
            markers.append({'t': deadline, 'type': marker_type, 'filled': False, 'is_deadline': True})
    markers.sort(key=lambda m: m['t'])
    return markers


def _add_months(d: date, months: int) -> date:
    total = d.year * 12 + (d.month - 1) + months
    y, m = divmod(total, 12)
    return date(y, m + 1, 1)


def _axis_bounds(dates: list[date], today: date) -> tuple[bool, list[date]]:
    """Zelfde as-logica als timelineBandBoundaries()/computeProjectTimelineBounds()
    in tree.html: 'vandaag' telt altijd mee in het bereik, bij een spanne van
    meer dan ~460 dagen worden het kwartalen i.p.v. maanden. Gedeeld door de
    projecttijdlijn (markers) en de activiteiten-Gantt (start/einddata)
    hieronder, zodat beide dezelfde as-conventie gebruiken."""
    all_dates = dates + [today]
    raw_min, raw_max = min(all_dates), max(all_dates)
    if raw_min == raw_max:
        raw_min -= timedelta(days=1)
        raw_max += timedelta(days=1)
    quarterly = (raw_max - raw_min).days > 460
    step = 3 if quarterly else 1
    first = date(raw_min.year, raw_min.month, 1)
    if quarterly:
        first = date(first.year, ((first.month - 1) // 3) * 3 + 1, 1)
    bounds = [first]
    while bounds[-1] < raw_max:
        bounds.append(_add_months(bounds[-1], step))
    return quarterly, bounds


def _add_project_timeline(slide, top, products: list[dict[str, Any]], today_iso: str):
    """Tekent de projecttijdlijn en geeft de Y-positie net onder de tijdlijn
    terug, zodat de aanroeper de inhoud eronder kan plaatsen -- of None als
    geen enkel product een verwachte/werkelijke datum of deadline heeft (dan
    is er niets te plotten, zelfde als productTimelineHtml() '' in tree.html)."""
    markers = _build_timeline_markers(products)
    if not markers:
        return None

    today = _parse_iso_date(today_iso) or date.today()
    quarterly, bounds = _axis_bounds([m['t'] for m in markers], today)
    axis_start, axis_end = bounds[0], bounds[-1]
    span_days = (axis_end - axis_start).days or 1

    # Kleine marge aan weerszijden zodat een marker precies op het begin/eind
    # van het bereik (bv. een mijlpaal exact op de laatste maandgrens) niet
    # half buiten de tijdlijn/slide valt.
    pad = Inches(0.1)
    inner_left = MARGIN + pad
    inner_w = CONTENT_W - 2 * pad

    def x_for(d: date) -> int:
        frac = (d - axis_start).days / span_days
        return int(inner_left + inner_w * frac)

    axis_y = top + Inches(0.68)

    for i in range(len(bounds) - 1):
        left = x_for(bounds[i])
        width = x_for(bounds[i + 1]) - left
        if width >= Inches(0.75):
            label = (
                f'K{(bounds[i].month - 1) // 3 + 1} {bounds[i].year}' if quarterly
                else f'{MAANDEN_KORT[bounds[i].month - 1].capitalize()} {bounds[i].year}'
            )
            _add_text(slide, left, axis_y + Inches(0.08), width, Inches(0.25), label, size=9, color=MUTED, align=PP_ALIGN.CENTER)

    _add_rect(slide, MARGIN, axis_y, CONTENT_W, Pt(1.25), TIMELINE_AXIS_COLOR)

    if axis_start <= today <= axis_end:
        today_x = x_for(today)
        _add_rect(slide, today_x, top, Pt(1.25), Inches(0.62), ACCENT)
        _add_text(slide, today_x - Inches(0.35), top - Inches(0.02), Inches(0.7), Inches(0.2), 'vandaag', size=8, bold=True, color=ACCENT, align=PP_ALIGN.CENTER)

    # Eenvoudige verticale stapeling om markers die (bijna) op dezelfde datum
    # vallen niet exact over elkaar te laten landen -- zelfde bucket-aanpak
    # als productTimelineHtml in tree.html (geen echte collision-detectie,
    # maar volstaat voor de doorgaans kleine aantallen items per project).
    marker_size = Inches(0.14)
    half = Inches(0.07)
    bucket_counts: dict[int, int] = {}
    for m in markers:
        cx = x_for(m['t'])
        bucket = round((cx - MARGIN) / CONTENT_W * 60)
        stack = bucket_counts.get(bucket, 0)
        bucket_counts[bucket] = stack + 1
        level = stack % 3
        cy = axis_y - Inches(0.14) - int(Inches(0.16) * level)
        if m['is_deadline']:
            shape = slide.shapes.add_shape(MSO_SHAPE.ISOSCELES_TRIANGLE, cx - half, cy - half, marker_size, marker_size)
            shape.rotation = 180
            shape.fill.solid()
            shape.fill.fore_color.rgb = TIMELINE_DEADLINE_COLOR
            shape.line.color.rgb = TIMELINE_DEADLINE_COLOR
        else:
            mso = MSO_SHAPE.DIAMOND if m['type'] == 'mijlpaal' else MSO_SHAPE.OVAL
            shape = slide.shapes.add_shape(mso, cx - half, cy - half, marker_size, marker_size)
            shape.line.color.rgb = TIMELINE_MARKER_COLOR
            shape.line.width = Pt(1.25)
            shape.fill.solid()
            shape.fill.fore_color.rgb = TIMELINE_MARKER_COLOR if m['filled'] else WHITE
        shape.shadow.inherit = False

    legend_y = axis_y + Inches(0.38)
    legend_items = [
        ('deliverable', False, False, 'Deliverable · verwacht'),
        ('deliverable', True, False, 'Deliverable · opgeleverd'),
        ('mijlpaal', False, False, 'Mijlpaal · verwacht'),
        ('mijlpaal', True, False, 'Mijlpaal · gehaald'),
        (None, False, True, 'Deadline'),
    ]
    dot_size = Inches(0.11)
    legend_col_w = Inches(2.1)
    legend_x = MARGIN
    for marker_type, filled, is_deadline, label in legend_items:
        if is_deadline:
            shape = slide.shapes.add_shape(MSO_SHAPE.ISOSCELES_TRIANGLE, legend_x, legend_y, dot_size, dot_size)
            shape.rotation = 180
            shape.fill.solid()
            shape.fill.fore_color.rgb = TIMELINE_DEADLINE_COLOR
            shape.line.color.rgb = TIMELINE_DEADLINE_COLOR
        else:
            mso = MSO_SHAPE.DIAMOND if marker_type == 'mijlpaal' else MSO_SHAPE.OVAL
            shape = slide.shapes.add_shape(mso, legend_x, legend_y, dot_size, dot_size)
            shape.line.color.rgb = TIMELINE_MARKER_COLOR
            shape.line.width = Pt(1)
            shape.fill.solid()
            shape.fill.fore_color.rgb = TIMELINE_MARKER_COLOR if filled else WHITE
        shape.shadow.inherit = False
        _add_text(slide, legend_x + dot_size + Inches(0.08), legend_y - Inches(0.02), legend_col_w - dot_size - Inches(0.08), Inches(0.25), label, size=9, color=MUTED)
        legend_x += legend_col_w

    return legend_y + Inches(0.35)


# ---- Slide 1: Overzicht (status/RAG + projecttijdlijn + aandachtspunten) --

def _slide_overview(prs: Presentation, project: dict[str, Any], products: list[dict[str, Any]], meta: dict[str, Any]):
    slide = _blank_slide(prs)
    _add_rect(slide, 0, 0, SLIDE_W, SLIDE_H, LIGHT_BG)
    _add_rect(slide, 0, 0, SLIDE_W, Inches(0.18), ACCENT)

    _add_text(
        slide, MARGIN, Inches(0.42), CONTENT_W, Inches(0.3),
        (meta.get('doelenboom') or '').upper() + ('  ·  ' + (project.get('code') or '') if project.get('code') else ''),
        size=12, bold=True, color=ACCENT,
    )
    _add_text(slide, MARGIN, Inches(0.75), CONTENT_W, Inches(0.55), project.get('name') or 'Project', size=28, bold=True, color=DARK)

    description = (project.get('description') or '').strip()
    y = Inches(1.38)
    if description:
        _add_text(slide, MARGIN, y, CONTENT_W, Inches(0.4), _truncate(description, 160), size=13, color=MUTED)
        y += Inches(0.42)

    status = project.get('status') or {}
    rag = status.get('rag') or ''
    projectstatus = status.get('projectstatus') or 'Onbekend'
    rag_label = rag.title() if rag else 'Niet gerapporteerd'

    badge_top = y + Inches(0.08)
    badge_w, badge_h = Inches(2.3), Inches(0.85)
    _add_rect(slide, MARGIN, badge_top, badge_w, badge_h, _rag_color(rag))
    _add_text(slide, MARGIN, badge_top + Inches(0.12), badge_w, Inches(0.4), rag_label, size=18, bold=True, color=WHITE, align=PP_ALIGN.CENTER)
    _add_text(slide, MARGIN, badge_top + Inches(0.52), badge_w, Inches(0.28), 'RAG-status', size=10, color=WHITE, align=PP_ALIGN.CENTER)

    info_left = MARGIN + badge_w + Inches(0.4)
    info_w = CONTENT_W - badge_w - Inches(0.4)
    _add_text(slide, info_left, badge_top, info_w, Inches(0.28), 'PROJECTSTATUS', size=10, bold=True, color=MUTED)
    _add_text(slide, info_left, badge_top + Inches(0.26), info_w, Inches(0.36), projectstatus, size=18, bold=True, color=DARK)
    _add_text(
        slide, info_left, badge_top + Inches(0.64), info_w, Inches(0.28),
        'Gerapporteerd op ' + _fmt_date(status.get('gerapporteerdOp')), size=11, color=MUTED,
    )

    y = badge_top + badge_h + Inches(0.2)

    # Projecttijdlijn (verwachte/werkelijke opleverdatum + deadline per
    # product) -- geeft None terug als geen enkel product een datum heeft;
    # de aandachtspunten hieronder schuiven dan gewoon een stuk omhoog i.p.v.
    # een lege ruimte over te laten (graceful degradation).
    timeline_bottom = _add_project_timeline(slide, y, products, _today_iso(meta))
    y = (timeline_bottom + Inches(0.12)) if timeline_bottom else (y + Inches(0.1))

    # Aandachtspunten (toelichting/tags/organisatieonderdelen/cluster) --
    # wat resteert aan verticale ruimte tot de voettekst bepaalt hoeveel
    # tekst er getoond wordt; de toelichting zelf vervalt nooit, alleen de
    # lengte ervan en de losse chips-regel eronder passen zich aan.
    footer_y = SLIDE_H - Inches(0.72)
    available = int(footer_y) - int(y)
    if available > int(Inches(0.3)):
        _add_text(slide, MARGIN, y, CONTENT_W, Inches(0.25), 'AANDACHTSPUNTEN', size=10, bold=True, color=MUTED)
        y += Inches(0.28)

        toelichting = (status.get('toelichting') or '').strip() or 'Geen toelichting vastgelegd bij de huidige status.'
        max_chars = 320 if available > int(Inches(1.3)) else 170
        _add_text(slide, MARGIN, y, CONTENT_W, Inches(0.75), _truncate(toelichting, max_chars), size=12, color=DARK)
        y += Inches(0.7) if available > int(Inches(1.0)) else Inches(0.5)

        remaining = int(footer_y) - int(y)
        if remaining > int(Inches(0.22)):
            parts = []
            tags = project.get('tags') or []
            if tags:
                parts.append('Tags: ' + ', '.join(tags))
            orgs = project.get('orgs') or []
            if orgs:
                parts.append('Organisaties: ' + ', '.join(f"{o.get('name', '')} ({o.get('relatietype', '')})" for o in orgs))
            if status.get('clusterPpt'):
                parts.append('Cluster PPT: ' + status['clusterPpt'])
            if parts:
                _add_text(slide, MARGIN, y, CONTENT_W, Inches(0.5), '   ·   '.join(parts), size=10, color=MUTED)

    generated_by = meta.get('exportedBy') or 'onbekend'
    generated_at = _fmt_date(meta.get('exportedAt'))
    _add_text(
        slide, MARGIN, SLIDE_H - Inches(0.72), CONTENT_W, Inches(0.25),
        f'Automatisch gegenereerd op {generated_at} door {generated_by} vanuit Doelenboom.', size=9, color=MUTED,
    )
    _footer(slide, project, meta, 1)
    return slide


# ---- Slides 2..N / N+1: deliverable-tabellen (openstaand + komende 2 mnd) --

DELIVERABLE_HEADERS = ['Deliverable', 'Type', 'Verwachte datum', '% gereed']


def _deliverable_col_widths() -> list[int]:
    c0, c1, c2 = Inches(6.3), Inches(1.9), Inches(2.3)
    return [c0, c1, c2, int(CONTENT_W) - c0 - c1 - c2]


def _product_row(p: dict[str, Any]) -> list[str]:
    type_label = 'Mijlpaal' if p.get('type') == 'mijlpaal' else 'Deliverable'
    return [p.get('name') or '', type_label, _fmt_date(p.get('verwachteDatum')), f"{_pct(p.get('pctGereed'))}%"]


def _month_range_label(start: date, second_month_start: date) -> str:
    if start.year == second_month_start.year:
        return f'{MAANDEN_KORT[start.month - 1].capitalize()} – {MAANDEN_KORT[second_month_start.month - 1].capitalize()} {start.year}'
    return (
        f'{MAANDEN_KORT[start.month - 1].capitalize()} {start.year} – '
        f'{MAANDEN_KORT[second_month_start.month - 1].capitalize()} {second_month_start.year}'
    )


def _slide_table(
    prs: Presentation, project: dict[str, Any], meta: dict[str, Any], page: int, *,
    kicker: str, title: str, headers: list[str], col_widths: list[int],
    rows: list[list[str]], subtitle: str | None = None,
):
    """Generieke, gepagineerde tabel-slide -- gebruikt voor zowel de
    openstaande-deliverables- als de komende-2-maanden-slide(s), zodat beide
    exact dezelfde opmaak/kolommen delen."""
    slide = _blank_slide(prs)
    _slide_header(slide, kicker, title)

    top = Inches(1.55)
    if subtitle:
        _add_text(slide, MARGIN, top, CONTENT_W, Inches(0.3), subtitle, size=12, color=MUTED)
        top += Inches(0.4)

    n_rows = len(rows) + 1
    row_height = Inches(0.4)
    table_height = row_height * n_rows
    gfx = slide.shapes.add_table(n_rows, len(headers), MARGIN, top, CONTENT_W, table_height)
    table = gfx.table
    for row in table.rows:
        row.height = row_height
    for c, w in enumerate(col_widths):
        table.columns[c].width = w

    for c, h in enumerate(headers):
        cell = table.cell(0, c)
        cell.text = h
        cell.text_frame.paragraphs[0].font.bold = True
        cell.text_frame.paragraphs[0].font.size = Pt(11)
        cell.fill.solid()
        cell.fill.fore_color.rgb = ACCENT
        cell.text_frame.paragraphs[0].font.color.rgb = WHITE

    for r, values in enumerate(rows, start=1):
        for c, v in enumerate(values):
            cell = table.cell(r, c)
            cell.text = v
            cell.text_frame.paragraphs[0].font.size = Pt(11)
            cell.fill.solid()
            cell.fill.fore_color.rgb = WHITE if r % 2 else LIGHT_BG

    _footer(slide, project, meta, page)
    return slide


def _slide_empty_list(prs: Presentation, project: dict[str, Any], meta: dict[str, Any], page: int, *, kicker: str, title: str, message: str):
    slide = _blank_slide(prs)
    _slide_header(slide, kicker, title)
    _add_text(slide, MARGIN, Inches(1.8), CONTENT_W, Inches(0.5), message, size=14, color=MUTED)
    _footer(slide, project, meta, page)
    return slide


# ---- Deliverables als tiles (zelfde kaartvorm als productCardHtml op het
# scherm in de app: badges, naam, voortgangsbalk, datums) --

def _add_product_tile(slide, left, top, w, h, p: dict[str, Any], today_iso: str):
    _add_rect(slide, left, top, w, h, WHITE, line=True)
    pad = Inches(0.14)
    inner_left = left + pad
    inner_w = w - 2 * pad
    cy = top + pad

    badge_h = Inches(0.22)
    bx = inner_left
    type_label = 'Mijlpaal' if p.get('type') == 'mijlpaal' else 'Deliverable'
    bx = _add_badge(slide, bx, cy, type_label, bg=ACCENT, h=badge_h)

    delivered = bool(p.get('werkelijkeDatum'))
    verwacht = _parse_iso_date(p.get('verwachteDatum'))
    today = _parse_iso_date(today_iso) or date.today()
    overdue = (not delivered) and verwacht is not None and verwacht < today
    if overdue:
        bx = _add_badge(slide, bx, cy, 'Te laat', bg=RAG_COLORS['rood'], h=badge_h)

    bv = _num(p.get('businessValue'))
    if bv is not None:
        bv_text = f'BV {int(bv)}' if bv == int(bv) else f'BV {bv}'
        bx = _add_badge(slide, bx, cy, bv_text, bg=MUTED, h=badge_h)

    cy += badge_h + Inches(0.1)

    name = _truncate(p.get('name') or '', 46)
    _add_text(slide, inner_left, cy, inner_w, Inches(0.4), name, size=12, bold=True, color=DARK)
    cy += Inches(0.44)

    pct = _pct(p.get('pctGereed'))
    bar_h = Inches(0.09)
    _add_rect(slide, inner_left, cy, inner_w, bar_h, LIGHT_BG)
    if pct > 0:
        fill_w = max(int(inner_w * pct / 100), int(Pt(2)))
        _add_rect(slide, inner_left, cy, fill_w, bar_h, ACCENT)
    _add_text(slide, inner_left, cy + Inches(0.13), inner_w, Inches(0.2), f'{pct}% gereed', size=9, color=MUTED)
    cy += Inches(0.4)

    if delivered:
        date_line = f"Opgeleverd: {_fmt_date(p.get('werkelijkeDatum'))}"
    else:
        date_line = f"Verwacht: {_fmt_date(p.get('verwachteDatum'))}"
    _add_text(slide, inner_left, cy, inner_w, Inches(0.2), date_line, size=9, color=MUTED)
    cy += Inches(0.22)

    if not delivered and p.get('deadline'):
        _add_text(slide, inner_left, cy, inner_w, Inches(0.2), f"Deadline: {_fmt_date(p.get('deadline'))}", size=9, color=TIMELINE_DEADLINE_COLOR)


def _slide_tiles(
    prs: Presentation, project: dict[str, Any], meta: dict[str, Any], page: int, *,
    kicker: str, title: str, subtitle: str | None, items: list[dict[str, Any]], today_iso: str,
):
    slide = _blank_slide(prs)
    _slide_header(slide, kicker, title)

    top0 = Inches(1.5)
    if subtitle:
        _add_text(slide, MARGIN, top0, CONTENT_W, Inches(0.3), subtitle, size=12, color=MUTED)
        top0 += Inches(0.35)

    gap = Inches(0.22)
    tile_w = (int(CONTENT_W) - (TILE_COLS - 1) * int(gap)) // TILE_COLS
    area_bottom = SLIDE_H - Inches(0.55)
    tile_h = (int(area_bottom) - int(top0) - (TILE_ROWS_PER_SLIDE - 1) * int(gap)) // TILE_ROWS_PER_SLIDE

    for i, p in enumerate(items[:TILES_PER_SLIDE]):
        row, col = divmod(i, TILE_COLS)
        left = MARGIN + col * (tile_w + gap)
        top = top0 + row * (tile_h + gap)
        _add_product_tile(slide, left, top, tile_w, tile_h, p, today_iso)

    _footer(slide, project, meta, page)
    return slide


# ---- Laatste slide(s): activiteiten als Gantt-tijdsbalken op een gezamen-
# lijke datum-as (vervangt de eerdere 3-kolommen bullet-lijst) --

LABEL_COL_W = Inches(2.6)
GANTT_DONE_COLOR = RGBColor(0xA6, 0xAD, 0xB8)
GANTT_ACTIVE_COLOR = RGBColor(0x00, 0x28, 0x55)
GANTT_FUTURE_COLOR = RGBColor(0xB7, 0xC6, 0xE6)
GANTT_DEP_COLOR = RGBColor(0x2F, 0x55, 0x97)  # zelfde blauw als het schakel-icoontje in tree.html
GANTT_DEP_VIOLATED_COLOR = RGBColor(0xDC, 0x35, 0x45)

# Zelfde omrekening/labels als DUUR_EENHEID_DAYS/-LABELS in tree.html, nodig
# om een product met een ingevulde duur als "doorlooptijd"-balkje te tonen
# (_product_bar_info hieronder).
DUUR_EENHEID_DAYS = {'d': 1, 'w': 7, 'm': 30, 'y': 365}
DUUR_EENHEID_LABELS = {'d': 'dagen', 'w': 'weken', 'm': 'maanden', 'y': 'jaar'}


def _activity_dates(activities: list[dict[str, Any]]) -> list[date]:
    dates: list[date] = []
    for a in activities:
        start = _parse_iso_date(a.get('startDate'))
        end = _parse_iso_date(a.get('endDate')) or start
        if start:
            dates.append(start)
        if end:
            dates.append(end)
    return dates


def _gantt_axis_bounds(products: list[dict[str, Any]], real_activities: list[dict[str, Any]], today: date) -> tuple[bool, list[date]]:
    """Zelfde voorrang als activityGanttHtml in tree.html: als het project
    gedateerde producten heeft, is de projecttijdlijn-as (zelfde as als
    slide 1) LEIDEND, zodat beide vergelijkbaar blijven -- alleen als geen
    enkel product een bruikbare datum heeft valt dit terug op het eigen
    bereik van de activiteiten."""
    markers = _build_timeline_markers(products)
    if markers:
        return _axis_bounds([m['t'] for m in markers], today)
    return _axis_bounds(_activity_dates(real_activities), today)


def _gantt_x_for(d: date, axis_start: date, span_days: int, inner_left: int, inner_w: int) -> int:
    # Geclipt binnen het zichtbare as-bereik -- zelfde aanpak als pctFor in
    # tree.html: een balkje/marker die (deels) buiten de as valt komt tegen
    # de rand te staan i.p.v. de as op te rekken. Nodig omdat een product-
    # balkje (_product_bar_info) een AFGELEIDE startdatum kan hebben die ver
    # vóór het as-bereik ligt (bv. een lange 'duur' terwijl de as zelf op de
    # opleverdata/deadlines is gebaseerd) -- zonder clip zou zo'n balkje tot
    # ver buiten/over de labelkolom heen getekend worden.
    frac = (d - axis_start).days / span_days
    frac = min(max(frac, 0.0), 1.0)
    return int(inner_left + inner_w * frac)


def _gantt_status_color(start: date | None, end: date | None, today: date) -> RGBColor:
    if end and end < today:
        return GANTT_DONE_COLOR
    if start and start <= today and (end is None or end >= today):
        return GANTT_ACTIVE_COLOR
    return GANTT_FUTURE_COLOR


def _gantt_row_color(a: dict[str, Any], today: date) -> RGBColor:
    start = _parse_iso_date(a.get('startDate'))
    end = _parse_iso_date(a.get('endDate')) or start
    return _gantt_status_color(start, end, today)


# ---- Deliverables/mijlpalen mét een ingevulde duur (of een afhankelijkheid)
# op de Activiteiten-Gantt -- zelfde opzet als productDeliverableBarInfo/
# productDependencyViolated/deliverableRowsHtml in tree.html: op het scherm
# staan deze producten OOK in de "Activiteiten"-sectie (als gestreept
# balkje, met de afgeleide doorlooptijd en de afhankelijkheid-relaties),
# dus horen ze ook op deze slide, niet alleen de losse `activities`-rijen.

def _product_bar_info(p: dict[str, Any]) -> dict[str, Any] | None:
    if not p.get('duur'):
        return None
    end = _parse_iso_date(p.get('werkelijkeDatum') or p.get('verwachteDatum'))
    if end is None:
        return None
    duur = _num(p.get('duur')) or 0
    days = duur * DUUR_EENHEID_DAYS.get(p.get('duurEenheid'), 1)
    if not days > 0:
        return None
    eenheid = p.get('duurEenheid')
    return {
        'start': end - timedelta(days=days),
        'end': end,
        'type': 'mijlpaal' if p.get('type') == 'mijlpaal' else 'deliverable',
        'verwacht': _parse_iso_date(p.get('verwachteDatum')),
        'werkelijk': _parse_iso_date(p.get('werkelijkeDatum')),
        'deadline': _parse_iso_date(p.get('deadline')),
        'duration_label': f"{p.get('duur')} {DUUR_EENHEID_LABELS.get(eenheid, eenheid or '')}",
    }


def _product_single_point(p: dict[str, Any]) -> date | None:
    return _parse_iso_date(p.get('werkelijkeDatum') or p.get('verwachteDatum'))


def _product_dependency_violated(pred: dict[str, Any] | None, succ: dict[str, Any] | None, dep: dict[str, Any]) -> bool | None:
    """Zelfde toetsing als productDependencyViolated() in tree.html: de
    opvolger mag niet beginnen vóór het einde van de voorganger + de
    vertraging van de afhankelijkheid."""
    if not pred or not succ:
        return None
    pred_end = _product_single_point(pred)
    if pred_end is None:
        return None
    lag_days = (dep.get('lagAmount') or 0) * DUUR_EENHEID_DAYS.get(dep.get('lagEenheid'), 1)
    required = pred_end + timedelta(days=lag_days)
    succ_info = _product_bar_info(succ)
    succ_start = succ_info['start'] if succ_info else _product_single_point(succ)
    if succ_start is None:
        return None
    return succ_start < required


def _annotate_product_dependencies(product_dependencies: list[dict[str, Any]], products: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Voegt 'violated' toe aan elke productafhankelijkheid (None als niet te
    bepalen) -- eenmalig berekend, gedeeld door zowel de rij-badges
    (_build_product_dep_index) als de pijl-kleur bij het tekenen."""
    products_by_id = {p.get('id'): p for p in products}
    result = []
    for d in product_dependencies or []:
        pred = products_by_id.get(d.get('predecessorId'))
        succ = products_by_id.get(d.get('successorId'))
        result.append({**d, 'violated': _product_dependency_violated(pred, succ, d)})
    return result


def _build_product_dep_index(annotated_product_dependencies: list[dict[str, Any]]) -> dict[Any, list[dict[str, Any]]]:
    index: dict[Any, list[dict[str, Any]]] = {}
    for d in annotated_product_dependencies:
        entry = {'violated': d.get('violated')}
        index.setdefault(d.get('predecessorId'), []).append(entry)
        index.setdefault(d.get('successorId'), []).append(entry)
    return index


def _build_gantt_rows(
    real_activities: list[dict[str, Any]], products: list[dict[str, Any]], annotated_product_dependencies: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Combineert echte activiteiten en deliverables/mijlpalen (mét een
    ingevulde duur, of -- zonder duur -- mét een afhankelijkheid) tot één
    gezamenlijke rijenlijst, zelfde opzet als activityGanttHtml in
    tree.html (rowsHtml gevolgd door deliverableRowsHtml)."""
    dep_index = _build_product_dep_index(annotated_product_dependencies)
    rows: list[dict[str, Any]] = [{'kind': 'activity', 'ref': a} for a in real_activities]
    for p in products:
        info = _product_bar_info(p)
        dep_entries = dep_index.get(p.get('id'))
        if not info and not dep_entries:
            continue
        rows.append({'kind': 'product', 'ref': p, 'info': info, 'dep_entries': dep_entries})
    return rows


def _add_point_marker(slide, cx: int, cy: int, size: int, mso, *, filled: bool, color: RGBColor = TIMELINE_MARKER_COLOR):
    half = size // 2
    shape = slide.shapes.add_shape(mso, cx - half, cy - half, size, size)
    shape.shadow.inherit = False
    shape.line.color.rgb = color
    shape.line.width = Pt(1.25)
    shape.fill.solid()
    shape.fill.fore_color.rgb = color if filled else WHITE
    return shape


def _add_deadline_marker(slide, cx: int, cy: int, size: int):
    half = size // 2
    shape = slide.shapes.add_shape(MSO_SHAPE.ISOSCELES_TRIANGLE, cx - half, cy - half, size, size)
    shape.rotation = 180
    shape.shadow.inherit = False
    shape.fill.solid()
    shape.fill.fore_color.rgb = TIMELINE_DEADLINE_COLOR
    shape.line.color.rgb = TIMELINE_DEADLINE_COLOR
    return shape


def _draw_gantt_dependency(slide, layout: dict[Any, dict[str, int]], pred_key, succ_key, dep_type: str, *, violated: bool):
    """Tekent één afhankelijkheid als "elleboog"-pijl (twee horizontale
    segmenten + één verticale, plus pijlpunt) van het ankerpunt van de
    voorganger naar dat van de opvolger -- zelfde opzet als
    dependencyArrowsHtml in tree.html. Ontbreekt de voorganger en/of de
    opvolger in `layout` (bv. omdat die rij op een andere Gantt-pagina
    staat, of geen bruikbare datum had), dan wordt de pijl stilzwijgend
    overgeslagen -- zelfde aanpak als op het scherm."""
    pred = layout.get(pred_key)
    succ = layout.get(succ_key)
    if not pred or not succ:
        return
    color = GANTT_DEP_VIOLATED_COLOR if violated else GANTT_DEP_COLOR
    pred_x = pred['left'] if dep_type in ('SS', 'SF') else pred['right']
    succ_x = succ['right'] if dep_type in ('FF', 'SF') else succ['left']
    y1, y2 = pred['mid_y'], succ['mid_y']
    stub = int(Inches(0.12))
    direction = 1 if succ_x >= pred_x else -1
    mid_x = pred_x + stub * direction
    thickness = int(Pt(1.5))
    half_t = thickness // 2
    _add_rect(slide, min(pred_x, mid_x), y1 - half_t, max(abs(mid_x - pred_x), thickness), thickness, color)
    _add_rect(slide, mid_x - half_t, min(y1, y2), thickness, max(abs(y2 - y1), thickness), color)
    _add_rect(slide, min(mid_x, succ_x), y2 - half_t, max(abs(succ_x - mid_x), thickness), thickness, color)
    arrow_size = int(Inches(0.09))
    arrow = slide.shapes.add_shape(MSO_SHAPE.ISOSCELES_TRIANGLE, succ_x - arrow_size // 2, y2 - arrow_size // 2, arrow_size, arrow_size)
    arrow.rotation = 90 if succ_x >= mid_x else -90
    arrow.shadow.inherit = False
    arrow.fill.solid()
    arrow.fill.fore_color.rgb = color
    arrow.line.fill.background()


def _add_gantt_axis(slide, top, bottom, bounds: list[date], quarterly: bool, today: date, inner_left: int, inner_w: int, axis_start: date, span_days: int):
    for i in range(len(bounds) - 1):
        gx = _gantt_x_for(bounds[i], axis_start, span_days, inner_left, inner_w)
        if i > 0:
            _add_rect(slide, gx, top, Pt(1), bottom - top, TIMELINE_AXIS_COLOR)
        next_gx = _gantt_x_for(bounds[i + 1], axis_start, span_days, inner_left, inner_w)
        if next_gx - gx >= int(Inches(0.55)):
            label = (
                f'K{(bounds[i].month - 1) // 3 + 1} {bounds[i].year}' if quarterly
                else f'{MAANDEN_KORT[bounds[i].month - 1].capitalize()} {bounds[i].year}'
            )
            _add_text(slide, gx, top - Inches(0.24), next_gx - gx, Inches(0.22), label, size=9, color=MUTED, align=PP_ALIGN.CENTER)
    if bounds[0] <= today <= bounds[-1]:
        today_x = _gantt_x_for(today, axis_start, span_days, inner_left, inner_w)
        _add_rect(slide, today_x, top, Pt(1.25), bottom - top, ACCENT)
        # Eigen regel bóven de maandkoppen (i.p.v. ernaast) zodat 'vandaag'
        # nooit overlapt met een maandlabel dat toevallig vlak naast de
        # 'vandaag'-lijn valt (bv. begin van de maand).
        _add_text(slide, today_x - Inches(0.35), top - Inches(0.46), Inches(0.7), Inches(0.2), 'vandaag', size=8, bold=True, color=ACCENT, align=PP_ALIGN.CENTER)


def _slide_activiteiten_gantt(
    prs: Presentation, project: dict[str, Any], meta: dict[str, Any], page: int,
    rows_page: list[dict[str, Any]], bounds: list[date], quarterly: bool,
    axis_start: date, span_days: int, today: date,
    activity_dependencies: list[dict[str, Any]], annotated_product_dependencies: list[dict[str, Any]],
    subtitle: str | None,
):
    slide = _blank_slide(prs)
    _slide_header(slide, 'Planning', 'Activiteiten')

    top0 = Inches(1.5)
    if subtitle:
        _add_text(slide, MARGIN, top0, CONTENT_W, Inches(0.3), subtitle, size=12, color=MUTED)
        top0 += Inches(0.3)

    pad = Inches(0.05)
    inner_left = MARGIN + LABEL_COL_W + pad
    inner_w = CONTENT_W - LABEL_COL_W - 2 * pad

    axis_top = top0 + Inches(0.5)
    rows_top = axis_top + Inches(0.15)
    footer_y = SLIDE_H - Inches(0.55)
    # Rijhoogte is altijd gebaseerd op GANTT_ROWS_PER_SLIDE (niet op het
    # daadwerkelijke aantal rijen op déze pagina), zodat alle Gantt-slides
    # dezelfde rijhoogte gebruiken -- een laatste, minder volle pagina laat
    # dan gewoon lege ruimte onderaan i.p.v. uitgerekte balken.
    row_height = (int(footer_y) - int(rows_top)) // GANTT_ROWS_PER_SLIDE

    chart_bottom = int(rows_top) + row_height * len(rows_page)
    _add_gantt_axis(slide, axis_top, chart_bottom, bounds, quarterly, today, inner_left, inner_w, axis_start, span_days)

    # dbId (met 'a'/'p'-prefix, net als layoutByDbId in tree.html) ->
    # ankerpunt voor de afhankelijkheid-pijlen hieronder.
    layout: dict[Any, dict[str, int]] = {}
    marker_size = int(Inches(0.13))

    for i, row in enumerate(rows_page):
        row_top = rows_top + i * row_height
        bar_h = row_height // 2
        bar_top = row_top + (row_height - bar_h) // 2
        mid_y = bar_top + bar_h // 2

        if row['kind'] == 'activity':
            a = row['ref']
            label = ('◆ ' if a.get('isMilestone') else '') + _truncate(a.get('name') or '', 40)
            _add_text(
                slide, MARGIN, row_top, LABEL_COL_W - Inches(0.15), row_height, label,
                size=10, color=DARK, anchor=MSO_ANCHOR.MIDDLE,
            )
            color = _gantt_row_color(a, today)
            start = _parse_iso_date(a.get('startDate')) or today
            end = _parse_iso_date(a.get('endDate')) or start
            if a.get('isMilestone'):
                cx = _gantt_x_for(start, axis_start, span_days, inner_left, inner_w)
                half = bar_h // 2
                shape = slide.shapes.add_shape(MSO_SHAPE.DIAMOND, cx - half, bar_top, bar_h, bar_h)
                shape.shadow.inherit = False
                shape.fill.solid()
                shape.fill.fore_color.rgb = color
                shape.line.fill.background()
                layout[('a', a.get('id'))] = {'left': cx, 'right': cx, 'mid_y': mid_y}
            else:
                x0 = _gantt_x_for(start, axis_start, span_days, inner_left, inner_w)
                x1 = _gantt_x_for(end, axis_start, span_days, inner_left, inner_w)
                width = max(x1 - x0, int(Pt(3)))
                _add_rect(slide, x0, bar_top, width, bar_h, color)
                layout[('a', a.get('id'))] = {'left': x0, 'right': x1, 'mid_y': mid_y}
            continue

        # kind == 'product' -- deliverable/mijlpaal mét duur (balkje) en/of
        # een afhankelijkheid (badge + evt. puur een puntmarker); zie
        # _build_gantt_rows/productDeliverableBarInfo hierboven.
        p = row['ref']
        info = row['info']
        dep_entries = row['dep_entries']
        any_violated = bool(dep_entries) and any(e['violated'] for e in dep_entries)
        badge = '⚠ ' if any_violated else ('🔗 ' if dep_entries else '')
        is_mijlpaal = (info['type'] == 'mijlpaal') if info else (p.get('type') == 'mijlpaal')
        label = ('◆ ' if is_mijlpaal else '') + badge + _truncate(p.get('name') or '', 34)
        _add_text(
            slide, MARGIN, row_top, LABEL_COL_W - Inches(0.15), row_height, label,
            size=10, bold=bool(dep_entries), color=(GANTT_DEP_VIOLATED_COLOR if any_violated else DARK),
            anchor=MSO_ANCHOR.MIDDLE,
        )

        if info:
            x0 = _gantt_x_for(info['start'], axis_start, span_days, inner_left, inner_w)
            x1 = _gantt_x_for(info['end'], axis_start, span_days, inner_left, inner_w)
            width = max(x1 - x0, int(Pt(3)))
            color = _gantt_status_color(info['start'], info['end'], today)
            # Gestreept (i.p.v. effen) i.p.v. het effen navy van een echte
            # activiteit -- zelfde onderscheid als .activity-deliverable-bar
            # t.o.v. .activity-bar in tree.html: dit is een AFGELEIDE
            # doorlooptijd (uit 'duur'), geen eigen geplande periode.
            bar = _add_rect(slide, x0, bar_top, width, bar_h, None)
            bar.fill.patterned()
            bar.fill.pattern = MSO_PATTERN_TYPE.LIGHT_DOWNWARD_DIAGONAL
            bar.fill.fore_color.rgb = color
            bar.fill.back_color.rgb = WHITE
            if info['werkelijk'] is not None:
                cx = _gantt_x_for(info['werkelijk'], axis_start, span_days, inner_left, inner_w)
                _add_point_marker(slide, cx, mid_y, marker_size, MSO_SHAPE.DIAMOND if is_mijlpaal else MSO_SHAPE.OVAL, filled=True)
            if info['verwacht'] is not None:
                cx = _gantt_x_for(info['verwacht'], axis_start, span_days, inner_left, inner_w)
                _add_point_marker(slide, cx, mid_y, marker_size, MSO_SHAPE.DIAMOND if is_mijlpaal else MSO_SHAPE.OVAL, filled=False)
            if info['deadline'] is not None:
                cx = _gantt_x_for(info['deadline'], axis_start, span_days, inner_left, inner_w)
                _add_deadline_marker(slide, cx, mid_y, marker_size)
            layout[('p', p.get('id'))] = {'left': x0, 'right': x1, 'mid_y': mid_y}
        else:
            point = _product_single_point(p)
            if point is not None:
                cx = _gantt_x_for(point, axis_start, span_days, inner_left, inner_w)
                _add_point_marker(
                    slide, cx, mid_y, marker_size, MSO_SHAPE.DIAMOND if is_mijlpaal else MSO_SHAPE.OVAL,
                    filled=bool(p.get('werkelijkeDatum')),
                )
                layout[('p', p.get('id'))] = {'left': cx, 'right': cx, 'mid_y': mid_y}
            # Geen enkele bruikbare datum: rij blijft zonder ankerpunt --
            # een pijl ernaartoe wordt hieronder stilzwijgend overgeslagen,
            # zelfde aanpak als tree.html (zie _draw_gantt_dependency).

    # Afhankelijkheid-pijlen -- alleen tussen twee ankers die BEIDEN op
    # deze pagina staan: een relatie die een andere Gantt-pagina overspant
    # kan in een statische PPTX niet als doorlopende pijl getekend worden,
    # dus die wordt hier stilzwijgend overgeslagen (zelfde aanpak als
    # tree.html al hanteert voor een ontbrekend ankerpunt).
    for dep in activity_dependencies or []:
        _draw_gantt_dependency(
            slide, layout, ('a', dep.get('predecessorId')), ('a', dep.get('successorId')),
            dep.get('type') or 'FS', violated=False,
        )
    for dep in annotated_product_dependencies or []:
        _draw_gantt_dependency(
            slide, layout, ('p', dep.get('predecessorId')), ('p', dep.get('successorId')),
            dep.get('type') or 'FS', violated=bool(dep.get('violated')),
        )

    _footer(slide, project, meta, page)
    return slide


def build_project_pptx(data: dict[str, Any], meta: dict[str, Any]) -> bytes:
    project = data.get('project') or {}
    products = data.get('products') or []
    activities = data.get('activities') or []
    activity_dependencies = data.get('activityDependencies') or []
    product_dependencies = data.get('productDependencies') or []

    prs = _new_presentation()
    page = 1

    # Slide 1: overzicht (status/RAG, projecttijdlijn, aandachtspunten)
    _slide_overview(prs, project, products, meta)
    page += 1

    # Slides 2..N: ALLE openstaande deliverables/mijlpalen (geen top-N meer)
    open_products = [p for p in products if not p.get('werkelijkeDatum')]
    open_products.sort(key=lambda p: p.get('verwachteDatum') or '9999-99-99')
    open_pages = _paginate(open_products, DELIVERABLES_ROWS_PER_SLIDE)
    if open_pages:
        n = len(open_pages)
        for i, chunk in enumerate(open_pages):
            subtitle = f'{len(open_products)} openstaande deliverable(s)' + (f' — pagina {i + 1}/{n}' if n > 1 else '')
            _slide_table(
                prs, project, meta, page,
                kicker='Voortgang', title='Openstaande deliverables',
                headers=DELIVERABLE_HEADERS, col_widths=_deliverable_col_widths(),
                rows=[_product_row(p) for p in chunk], subtitle=subtitle,
            )
            page += 1
    else:
        message = 'Alle deliverables zijn opgeleverd.' if products else 'Nog geen deliverables vastgelegd voor dit project.'
        _slide_empty_list(prs, project, meta, page, kicker='Voortgang', title='Openstaande deliverables', message=message)
        page += 1

    # Slide N+1: gepland -- komende 2 maanden (alleen deliverables, geen
    # activiteiten -- zo afgesproken)
    today_date = _parse_iso_date(_today_iso(meta)) or date.today()
    range_start = date(today_date.year, today_date.month, 1)
    next_month_start = _add_months(range_start, 1)
    range_end_excl = _add_months(range_start, 2)
    label = _month_range_label(range_start, next_month_start)
    gepland = [
        p for p in open_products
        if (d := _parse_iso_date(p.get('verwachteDatum'))) is not None and range_start <= d < range_end_excl
    ]
    gepland.sort(key=lambda p: p.get('verwachteDatum') or '')
    gepland_pages = _paginate(gepland, DELIVERABLES_ROWS_PER_SLIDE)
    if gepland_pages:
        n = len(gepland_pages)
        for i, chunk in enumerate(gepland_pages):
            subtitle = f'{label} — {len(gepland)} deliverable(s)' + (f' — pagina {i + 1}/{n}' if n > 1 else '')
            _slide_table(
                prs, project, meta, page,
                kicker='Planning', title='Gepland — komende 2 maanden',
                headers=DELIVERABLE_HEADERS, col_widths=_deliverable_col_widths(),
                rows=[_product_row(p) for p in chunk], subtitle=subtitle,
            )
            page += 1
    else:
        _slide_empty_list(
            prs, project, meta, page, kicker='Planning', title='Gepland — komende 2 maanden',
            message=f'Geen deliverables gepland in {label}.',
        )
        page += 1

    # Slides N+2+: alle deliverables als tiles (open eerst, dan een aparte
    # sectie "opgeleverd/gehaald")
    delivered_products = [p for p in products if p.get('werkelijkeDatum')]
    delivered_products.sort(key=lambda p: p.get('werkelijkeDatum') or '', reverse=True)
    today_iso = _today_iso(meta)

    open_tile_pages = _paginate(open_products, TILES_PER_SLIDE)
    delivered_tile_pages = _paginate(delivered_products, TILES_PER_SLIDE)

    if not open_tile_pages and not delivered_tile_pages:
        _slide_empty_list(
            prs, project, meta, page, kicker='Deliverables', title='Deliverables',
            message='Nog geen deliverables vastgelegd voor dit project.',
        )
        page += 1
    else:
        n = len(open_tile_pages)
        for i, chunk in enumerate(open_tile_pages):
            subtitle = f'Openstaand — {len(open_products)} deliverable(s)' + (f' — pagina {i + 1}/{n}' if n > 1 else '')
            _slide_tiles(prs, project, meta, page, kicker='Deliverables', title='Deliverables', subtitle=subtitle, items=chunk, today_iso=today_iso)
            page += 1
        n = len(delivered_tile_pages)
        for i, chunk in enumerate(delivered_tile_pages):
            subtitle = f'Opgeleverd / gehaald ({len(delivered_products)})' + (f' — pagina {i + 1}/{n}' if n > 1 else '')
            _slide_tiles(prs, project, meta, page, kicker='Deliverables', title='Deliverables', subtitle=subtitle, items=chunk, today_iso=today_iso)
            page += 1

    # Laatste slide(s): activiteiten als Gantt-tijdsbalken -- inclusief
    # deliverables/mijlpalen met een ingevulde duur (doorlooptijd) en de
    # afhankelijkheid-relaties, want die staan op het scherm ook in de
    # "Activiteiten"-Gantt (zie _build_gantt_rows hierboven).
    real_activities = [a for a in activities if not a.get('isSummary')]
    real_activities.sort(key=lambda a: (a.get('startDate') or '', a.get('endDate') or ''))
    annotated_product_dependencies = _annotate_product_dependencies(product_dependencies, products)
    gantt_rows = _build_gantt_rows(real_activities, products, annotated_product_dependencies)
    if gantt_rows:
        quarterly, bounds = _gantt_axis_bounds(products, real_activities, today_date)
        axis_start, axis_end = bounds[0], bounds[-1]
        span_days = (axis_end - axis_start).days or 1
        gantt_pages = _paginate(gantt_rows, GANTT_ROWS_PER_SLIDE)
        n = len(gantt_pages)
        n_products_with_row = sum(1 for r in gantt_rows if r['kind'] == 'product')
        for i, chunk in enumerate(gantt_pages):
            bits = [f'{len(real_activities)} activiteit(en)']
            if n_products_with_row:
                bits.append(f'{n_products_with_row} deliverable(s) met doorlooptijd/afhankelijkheid')
            subtitle = ' · '.join(bits) + (f' — pagina {i + 1}/{n}' if n > 1 else '')
            _slide_activiteiten_gantt(
                prs, project, meta, page, chunk, bounds, quarterly, axis_start, span_days, today_date,
                activity_dependencies, annotated_product_dependencies, subtitle,
            )
            page += 1
    else:
        _slide_empty_list(
            prs, project, meta, page, kicker='Planning', title='Activiteiten',
            message='Nog geen activiteiten of deliverables met een doorlooptijd vastgelegd voor dit project.',
        )
        page += 1

    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()

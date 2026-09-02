"""
Cel-opschoning voor de Doelenboom-Referentietabel.

Regels overgenomen uit doelenboom_update_instructie.md §3.2, die gaandeweg dit
project handmatig zijn vastgesteld door meerdere Excel-versies te verwerken:
- None -> leeg
- datetime.time(0, 0) -> leeg (lege datumcel die als tijd 00:00 binnenkomt)
- datetime.datetime met jaar <= 1900 -> leeg (Excel-epoch-artefact)
- literal 0 (int/float) in een tekstveld -> leeg (formule-restje)
- "Geen FPBB-KPI" in de KPI-kolom -> "-"
"""
from __future__ import annotations

import datetime
import re


def _is_blank_time(value: object) -> bool:
    return isinstance(value, datetime.time) and value == datetime.time(0, 0)


def _is_epoch_artifact(value: object) -> bool:
    return isinstance(value, datetime.datetime) and value.year <= 1900


def clean_raw(value: object):
    """Normaliseert een ruwe celwaarde naar None als hij als 'leeg' geldt."""
    if value is None:
        return None
    if _is_blank_time(value):
        return None
    if _is_epoch_artifact(value):
        return None
    return value


def clean_text(value: object) -> str:
    """Voor tekstvelden: leeg -> '', literal 0 -> '', 'Geen FPBB-KPI' -> '-'."""
    v = clean_raw(value)
    if v is None:
        return ''
    if isinstance(v, (int, float)) and not isinstance(v, bool) and v == 0:
        return ''
    s = re.sub(r'\s+', ' ', str(v)).strip()
    if s == 'Geen FPBB-KPI':
        return '-'
    return s


def clean_date(value: object) -> str | None:
    v = clean_raw(value)
    if v is None:
        return None
    if isinstance(v, datetime.datetime):
        return v.date().isoformat()
    if isinstance(v, datetime.date):
        return v.isoformat()
    s = str(v).strip()
    return s or None


def clean_pct(value: object) -> int:
    """% gereed kan als 0-1 fractie (Excel-percentageformat) of als 0-100 binnenkomen."""
    v = clean_raw(value)
    if v is None:
        return 0
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0
    if 0 <= f <= 1:
        f *= 100
    return int(round(f))


def norm(s: object) -> str:
    """Genormaliseerde vorm van een string voor case/whitespace-ongevoelige matching."""
    if s is None:
        return ''
    return re.sub(r'\s+', ' ', str(s)).strip().lower()


def split_entries(value: object) -> list[str]:
    """Splitst een ';'/','-gescheiden celwaarde (bv. Tags, Voorgangers, Hangt
    af van) op in losse, getrimde items — lege items (dubbele scheiding,
    trailing komma) worden overgeslagen. Gedeeld door parser.py (Activiteiten-
    tab van de volledige-boom-export) en project_workbook.py (Producten-/
    Activiteiten-tab van de één-project-export), was vóór deze functie hier
    stond alleen een eigen kopie in project_workbook.py."""
    text = clean_text(value)
    if not text:
        return []
    return [p.strip() for p in re.split(r'[;,]', text) if p.strip()]

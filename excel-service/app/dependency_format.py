"""
Eén centrale plek voor het formatteren/parsen van een afhankelijkheid tussen
activiteiten (type EB/SS/FF/SF + vertraging in dagen) als één Excel-celwaarde,
bv. 'Taak A' (FS, geen vertraging — de default) of 'Taak B (SS)' /
'Taak C (FS+2)'.

Gedeeld door project_workbook.py (Voorgangers-kolom op de Activiteiten-tab van
de één-project-export) en exporter.py/parser.py (dezelfde kolom op de
Activiteiten-tab van de volledige-boom-export) — vóór deze module bestond,
stond dit alleen in project_workbook.py; nu de volledige-boom-export ook een
Activiteiten-tab kreeg, is dit uitgetrokken zodat beide exact hetzelfde
formaat gebruiken/verstaan i.p.v. twee losse implementaties die uit elkaar
kunnen gaan lopen.

Let op: dit gaat over ACTIVITEIT-afhankelijkheden (elk van de vier EB/SS/FF/SF-
types, lag in hele dagen). Productafhankelijkheden (tussen deliverables/
mijlpalen) zijn altijd FS en gebruiken lag_amount + lag_eenheid (d/w/m) i.p.v.
een vlakke lag_days — zie _format_product_dependency/_parse_product_dependency_entry
in project_workbook.py, die blijven daar (product-specifiek, geen ander
exportformaat gebruikt ze).
"""
from __future__ import annotations

import re

_DEP_RE = re.compile(r'^(?P<name>.*?)(?:\s*\((?P<type>[A-Za-z]{2})\s*(?P<lag>[+-]\d+)?\))?\s*$')
_VALID_DEP_TYPES = {'FS', 'SS', 'FF', 'SF'}


def format_dependency(name: str, dep_type: str | None, lag_days: int | None) -> str:
    """'Taak A' (FS, geen vertraging — de default) blijft kaal; alles anders
    krijgt een suffix, bv. 'Taak B (SS)' of 'Taak C (FS+2)'. Zie
    parse_dependency_entry hieronder voor de inverse."""
    dep_type = dep_type or 'FS'
    lag_days = lag_days or 0
    if dep_type == 'FS' and lag_days == 0:
        return name
    lag_part = f'{lag_days:+d}' if lag_days else ''
    return f'{name} ({dep_type}{lag_part})'


def parse_dependency_entry(entry: str) -> tuple[str, str, int]:
    """Inverse van format_dependency: 'Taak A' -> ('Taak A', 'FS', 0);
    'Taak B (SS)' -> ('Taak B', 'SS', 0); 'Taak C (FS+2)' -> ('Taak C', 'FS', 2).
    Een onherkend of ontbrekend type valt terug op 'FS' (dezelfde default als
    bij het aanmaken van een afhankelijkheid via de UI, zie
    api/src/routes/activities.ts)."""
    m = _DEP_RE.match(entry.strip())
    if not m:
        return entry.strip(), 'FS', 0
    name = (m.group('name') or '').strip()
    dep_type = (m.group('type') or 'FS').upper()
    if dep_type not in _VALID_DEP_TYPES:
        dep_type = 'FS'
    lag_raw = m.group('lag')
    lag_days = int(lag_raw) if lag_raw else 0
    return name, dep_type, lag_days

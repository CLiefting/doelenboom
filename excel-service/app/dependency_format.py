"""
Eén centrale plek voor het formatteren/parsen van een afhankelijkheid (tussen
activiteiten, of tussen producten/deliverables) als één Excel-celwaarde.

Gedeeld door project_workbook.py (Voorgangers-/Hangt af van-kolom op de
Activiteiten-/Producten-tab van de één-project-export) en exporter.py/
parser.py (dezelfde kolommen op de Activiteiten-/Producten-tab van de
volledige-boom-export) — vóór deze module bestond, stond dit alleen in
project_workbook.py; nu de volledige-boom-export dezelfde kolommen nodig
had, is dit uitgetrokken zodat beide exact hetzelfde formaat gebruiken/
verstaan i.p.v. twee losse implementaties die uit elkaar kunnen gaan lopen.

Twee losse paren functies, want het zijn twee andere afhankelijkheidsmodellen:
- Activiteiten: elk van de vier EB/SS/FF/SF-types, vertraging in hele dagen
  (activity_dependencies.lag_days) — format_dependency/parse_dependency_entry.
  Bv. 'Taak A' (FS, geen vertraging — de default) blijft kaal, 'Taak B (SS)',
  'Taak C (FS+2)'.
- Producten/deliverables: altijd FS (de API staat vooralsnog geen ander type
  toe, zie PRODUCT_DEPENDENCY_TYPES in api/src/routes/products.ts — een type
  hoeft hier dus niet opgeslagen te worden) en vertraging als lag_amount +
  lag_eenheid (d/w/m, product_dependencies.lag_amount/lag_eenheid) i.p.v. een
  vlakke aantal-dagen — format_product_dependency/parse_product_dependency_entry.
  Bv. 'Taak A' (geen vertraging) blijft kaal, 'Taak B (+2w)'.
"""
from __future__ import annotations

import re

_DEP_RE = re.compile(r'^(?P<name>.*?)(?:\s*\((?P<type>[A-Za-z]{2})\s*(?P<lag>[+-]\d+)?\))?\s*$')
_VALID_DEP_TYPES = {'FS', 'SS', 'FF', 'SF'}
_PRODUCT_DEP_RE = re.compile(r'^(?P<name>.*?)(?:\s*\((?P<lag>[+-]?\d+(?:\.\d+)?)(?P<unit>[dwm])?\))?\s*$')


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


def format_product_dependency(name: str, lag_amount: int | float | None, lag_eenheid: str | None) -> str:
    """Zelfde idee als format_dependency, maar voor productafhankelijkheden:
    die zijn altijd FS (zie PRODUCT_DEPENDENCY_TYPES in
    api/src/routes/products.ts, de API dwingt dit server-side af — een type
    hoeft hier dus niet opgeslagen te worden) en gebruiken lag_amount +
    lag_eenheid (d/w/m) i.p.v. een vlakke lag_days zoals activiteiten. 'Taak A'
    (geen vertraging) blijft kaal; anders bv. 'Taak B (+2w)'. Zie
    parse_product_dependency_entry hieronder voor de inverse."""
    lag_amount = lag_amount or 0
    lag_eenheid = lag_eenheid or 'd'
    if lag_amount == 0:
        return name
    return f'{name} ({lag_amount:+g}{lag_eenheid})'


def parse_product_dependency_entry(entry: str) -> tuple[str, int | float, str]:
    """Inverse van format_product_dependency: 'Taak A' -> ('Taak A', 0, 'd');
    'Taak B (+2w)' -> ('Taak B', 2, 'w'). Ondersteunt ook kale oudere bestanden
    van vóór deze wijziging die alleen de naam bevatten (dan is er geen match
    op de haakjes-groep en valt lag/unit terug op 0/'d' — geen dataverlies
    t.o.v. het gedrag hiervoor, alleen geen extra informatie). Een ontbrekende
    eenheid-letter (bv. handmatig '(+2)' ingetypt) valt terug op 'd', dezelfde
    default als de API (zie PRODUCT_DEPENDENCY_LAG_EENHEDEN in
    api/src/routes/products.ts)."""
    m = _PRODUCT_DEP_RE.match(entry.strip())
    if not m:
        return entry.strip(), 0, 'd'
    name = (m.group('name') or '').strip()
    lag_raw = m.group('lag')
    unit_raw = (m.group('unit') or 'd').lower()
    if unit_raw not in ('d', 'w', 'm'):
        unit_raw = 'd'
    if not lag_raw:
        return name, 0, 'd'
    try:
        lag = float(lag_raw)
        lag_amount: int | float = int(lag) if lag == int(lag) else lag
    except ValueError:
        lag_amount = 0
    return name, lag_amount, unit_raw

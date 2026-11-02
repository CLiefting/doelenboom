"""DOEL-133: kenmerk "gevoelig" in Excel-bestanden uit de kluis.

De kluis is een lokale Doelenboom-omgeving voor doelenbomen met gevoelige(re)
informatie. Alles wat daaruit als Excel wordt geëxporteerd, krijgt:

  - een eigen documenteigenschap ``doelenboom_gevoelig = ja`` (docProps/custom.xml);
  - een zichtbare regel "Gevoelig" op het tabblad Configuratie (alleen bij de
    doelenboom-export; zie exporter.py).

Bij het inlezen (/parse en /project-parse) meldt de service of een bestand dat
kenmerk heeft; de API weigert zo'n bestand buiten de kluis (zie
api/src/omgeving.ts). Dit is een grendel tegen vergissingen (een gevoelig
bestand per ongeluk in productie inlezen), geen bescherming tegen iemand die
het kenmerk bewust uit het bestand haalt.

Het kenmerk wordt bij het inlezen rechtstreeks uit het zip-bestand gelezen,
los van openpyxl (dat de bestanden read-only opent), met een groottegrens en
defusedxml (OWASP A05/A08: geen XML-bommen of entiteiten).
"""
from __future__ import annotations

import io
import zipfile
from typing import Any

from defusedxml import ElementTree as SafeET
from openpyxl.packaging.custom import StringProperty

PROPERTY_NAME = 'doelenboom_gevoelig'
PROPERTY_VALUE = 'ja'
_CUSTOM_PART = 'docProps/custom.xml'
_MAX_CUSTOM_BYTES = 256 * 1024


def is_gevoelig_meta(meta: dict[str, Any] | None) -> bool:
    """Alleen een echte True telt (de API zet die alleen in de kluis)."""
    return bool(meta) and meta.get('gevoelig') is True


def markeer(wb: Any, meta: dict[str, Any] | None) -> None:
    """Zet het kenmerk op een openpyxl-Workbook als de export uit de kluis komt."""
    if not is_gevoelig_meta(meta):
        return
    if PROPERTY_NAME in wb.custom_doc_props.names:
        return
    wb.custom_doc_props.append(StringProperty(name=PROPERTY_NAME, value=PROPERTY_VALUE))


def is_gevoelig(content: bytes) -> bool:
    """Heeft dit .xlsx-bestand het kenmerk? Onleesbaar of geen zip = nee (de
    gewone parser meldt dan zelf wat er mis is)."""
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            try:
                info = zf.getinfo(_CUSTOM_PART)
            except KeyError:
                return False
            if info.file_size > _MAX_CUSTOM_BYTES:
                # Een echte custom.xml is klein; een enorme is verdacht. Voor de
                # zekerheid als gevoelig behandelen (dan wordt het bestand
                # buiten de kluis geweigerd, i.p.v. ongezien doorgelaten).
                return True
            xml = zf.read(info)
    except (zipfile.BadZipFile, OSError, RuntimeError, ValueError):
        return False
    try:
        root = SafeET.fromstring(xml)
    except Exception:  # noqa: BLE001 — kapotte XML: wel een custom.xml, niet te lezen
        return True
    for prop in root:
        if prop.attrib.get('name', '').strip().lower() == PROPERTY_NAME:
            return True
    return False

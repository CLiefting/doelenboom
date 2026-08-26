"""
Zet een geüpload .mpp-bestand (binair MS Project-formaat) om naar MS Project
XML (MSPDI) via MPXJ — een Java-bibliotheek, hier aangeroepen via het
mpxj-PyPI-pakket dat JPype gebruikt om de meegeleverde .jar's te draaien. Dat
vereist een JRE in de Docker-image (zie Dockerfile); er is geen bruikbare
pure-Python-library om het binaire .mpp-formaat zelf te lezen.

Puur een formaat-conversie: er zit hier GEEN taken-filtering of -mapping in.
tree.html leest de teruggegeven XML met dezelfde parseMppProjectXml() als een
rechtstreeks door de gebruiker aangeleverde MS Project XML-export (Bestand >
Opslaan als > XML) — zo bestaat de WBS-niveau-/mijlpaal-/fase-logica maar op
één plek (JavaScript, in de browser) en niet dubbel (ook hier in Python).

De JVM wordt lazy gestart (bij de eerste conversie, niet bij het importeren
van deze module) zodat /health en de bestaande Excel-routes niet afhankelijk
worden van een werkende Java-installatie, en zodat `pytest` deze module kan
importeren zonder meteen een JVM te starten (JPype's startJVM() kan maar één
keer per proces, en faalt hard als er geen JRE gevonden wordt).
"""
from __future__ import annotations

import tempfile
from pathlib import Path

_jvm_started = False


def _ensure_jvm() -> None:
    global _jvm_started
    if _jvm_started:
        return
    import mpxj

    mpxj.startJVM()
    _jvm_started = True


class MppConversionError(Exception):
    """Het aangeleverde bestand kon niet als MS Project-planning gelezen
    worden (onbekend, corrupt, of geen .mpp/.mpx/.xer/... bestand)."""


def mpp_to_mspdi_xml(content: bytes) -> str:
    """`content`: de ruwe bytes van een .mpp-upload. Schrijft ze naar een
    tijdelijk bestand, leest het met MPXJ's UniversalProjectReader (herkent
    zelf de exacte bestandsversie/-variant) en schrijft het resultaat als
    MSPDI-XML-tekst terug. Gooit MppConversionError als het bestand niet
    gelezen kon worden."""
    _ensure_jvm()
    # Pas ná _ensure_jvm() importeren: dit zijn Java-packages die JPype pas
    # kan resolven nadat de JVM gestart is.
    from org.mpxj.mspdi import MSPDIWriter  # noqa: PLC0415
    from org.mpxj.reader import UniversalProjectReader  # noqa: PLC0415

    with tempfile.TemporaryDirectory() as tmp:
        in_path = Path(tmp) / 'upload.mpp'
        out_path = Path(tmp) / 'output.xml'
        in_path.write_bytes(content)
        try:
            project = UniversalProjectReader().read(str(in_path))
        except Exception as exc:  # noqa: BLE001 — Java-exceptie, geen vast bruikbaar type hier
            raise MppConversionError(str(exc)) from exc
        if project is None:
            raise MppConversionError('Onherkend bestandsformaat.')
        MSPDIWriter().write(project, str(out_path))
        return out_path.read_text(encoding='utf-8')

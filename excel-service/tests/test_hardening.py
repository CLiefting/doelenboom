"""DOEL-31: defusedxml moet aanwezig en gepind zijn, en openpyxl moet het
daadwerkelijk gebruiken bij het parsen van (door gebruikers geüploade) xlsx-XML."""
import io
from pathlib import Path

import openpyxl
import pytest
from openpyxl.xml.functions import fromstring, iterparse

REQUIREMENTS = Path(__file__).resolve().parent.parent / "requirements.txt"

BILLION_LAUGHS = (
    '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">'
    '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>'
    "<lolz>&lol2;</lolz>"
)
XXE_FILE = (
    '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
    "<x>&xxe;</x>"
)


def test_defusedxml_is_pinned_in_requirements():
    lines = [l.strip() for l in REQUIREMENTS.read_text().splitlines() if l.strip() and not l.startswith("#")]
    assert any(l.startswith("defusedxml==") for l in lines), "defusedxml niet gepind in requirements.txt"


def test_openpyxl_uses_defusedxml():
    assert openpyxl.DEFUSEDXML is True


@pytest.mark.parametrize("payload", [BILLION_LAUGHS, XXE_FILE], ids=["entity-expansie", "extern-bestand"])
def test_streaming_parser_rejects_entity_declarations(payload):
    # openpyxl leest grote sheets via iterparse; met defusedxml geïnstalleerd is
    # dat defusedxml's variant, die een DOCTYPE met entities weigert
    # (EntitiesForbidden is een ValueError). Zonder defusedxml pakt openpyxl de
    # stdlib-parser, die deze payload wél accepteert.
    with pytest.raises(ValueError):
        list(iterparse(io.BytesIO(payload.encode())))


def test_external_entities_are_never_resolved_by_fromstring():
    # openpyxl.fromstring is lxml met resolve_entities=False (of defusedxml):
    # het bestand mag in geen geval worden ingelezen.
    try:
        root = fromstring(XXE_FILE)
    except ValueError:
        return
    assert "root:" not in "".join(root.itertext())

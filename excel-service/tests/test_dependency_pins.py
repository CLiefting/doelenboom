"""DOEL-121 (OWASP A06 — Vulnerable and Outdated Components): Pillow moet
expliciet gepind zijn op een versie zonder de kwetsbaarheden van 20 oktober
2026 (1 kritiek, 6 hoog in Pillow < 13.0.0), en de geïnstalleerde versie moet
daar ook echt aan voldoen.

Faalt aantoonbaar op Pillow 12.3.0 (de versie in release 4.4.0)."""
from importlib.metadata import version
from pathlib import Path

from packaging.version import Version

REQUIREMENTS = Path(__file__).resolve().parent.parent / "requirements.txt"
MIN_SAFE_PILLOW = Version("13.0.0")


def _pinned(name: str) -> str | None:
    for raw in REQUIREMENTS.read_text().splitlines():
        line = raw.split("#", 1)[0].strip()
        if line.lower().startswith(f"{name}=="):
            return line.split("==", 1)[1].strip()
    return None


def test_pillow_is_pinned_to_safe_version():
    pinned = _pinned("pillow")
    assert pinned is not None, "pillow niet expliciet gepind in requirements.txt (DOEL-121)"
    assert Version(pinned) >= MIN_SAFE_PILLOW, f"pillow=={pinned} is kwetsbaar, minimaal {MIN_SAFE_PILLOW} (DOEL-121)"


def test_installed_pillow_is_safe_version():
    installed = Version(version("pillow"))
    assert installed >= MIN_SAFE_PILLOW, f"geïnstalleerde Pillow {installed} is kwetsbaar, minimaal {MIN_SAFE_PILLOW} (DOEL-121)"

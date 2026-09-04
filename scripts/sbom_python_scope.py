#!/usr/bin/env python3
"""Bepaalt welke geïnstalleerde Python-packages in een venv "runtime" (nodig
voor requirements.txt, incl. transitief) versus "development" (alleen nodig
om te testen/bouwen, bv. pytest/httpx/cyclonedx-bom uit requirements-dev.txt)
zijn — voor de SBOM/dependency-health-functionaliteit (zie
scripts/generate-sbom.sh, api/src/dependencyHealth.ts en
doelenboom_sbom_ontwerp.md in het project).

Werkwijze: leest de top-level namen (mét eventuele extras, bv.
"uvicorn[standard]") uit requirements.txt (de "wortel" van de runtime-boom),
en volgt vanaf daar transitief elke VERPLICHTE Requires-Dist uit de
package-metadata van de al geïnstalleerde distributies in de gegeven venv
(importlib.metadata — stdlib, geen extra dependency nodig). Een Requires-Dist
die zelf achter een "; extra == ..."-marker zit, wordt alleen gevolgd als die
extra voor DIT package ook echt aangevraagd is (in requirements.txt, of
transitief doorgegeven zoals uvicorn[standard] -> httptools/uvloop/...) — dus
niet zomaar élke optionele extra van elk pakket, anders zou bv. fastapi's
optionele "standard"/"all"-extra (die zelf weer httpx/pytest-achtige tools
kan noemen) alles onterecht als runtime bestempelen terwijl requirements.txt
die extra niet aanvraagt. Alles wat zo bereikbaar is, is "runtime"; de rest
van wat in de venv geïnstalleerd staat (bv. pytest en zijn eigen transitieve
deps, en dit script z'n eigen cyclonedx-bom) is "development".

Gebruik:
  <venv>/bin/python3 scripts/sbom_python_scope.py <requirements.txt> <venv-pad>
Output (stdout): JSON {"runtimeNames": ["fastapi", "starlette", ...]}
(package-namen genormaliseerd: lowercase, "_"/"." -> "-", zoals PyPI/pip zelf
namen genormaliseerd vergelijkt — zie PEP 503).
"""
import json
import re
import sys
from importlib import metadata as importlib_metadata


def normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_requirement_roots(path: str) -> dict[str, set[str]]:
    """Naam -> aangevraagde extras (kan leeg zijn), voor elke top-level regel."""
    roots: dict[str, set[str]] = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or line.startswith("-"):
                    continue
                match = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[([^\]]*)\])?", line)
                if not match:
                    continue
                name = normalize(match.group(1))
                extras = {e.strip().lower() for e in (match.group(3) or "").split(",") if e.strip()}
                roots.setdefault(name, set()).update(extras)
    except FileNotFoundError:
        pass
    return roots


_EXTRA_MARKER_RE = re.compile(r"""extra\s*==\s*['"]([^'"]+)['"]""")


def parse_requirement_string(req: str) -> tuple[str, set[str], str | None]:
    """Eén Requires-Dist-regel -> (genormaliseerde naam, aangevraagde extras
    van díe dependency zelf, de "extra=..."-marker-naam van het ouder-package
    waarachter deze regel verstopt zit, of None als de regel onvoorwaardelijk
    (altijd) geldt)."""
    head, _, marker = req.partition(";")
    head = head.strip()
    name_match = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[([^\]]*)\])?", head)
    name = normalize(name_match.group(1)) if name_match else ""
    own_extras = {e.strip().lower() for e in (name_match.group(3) or "").split(",") if e.strip()} if name_match else set()
    gate_match = _EXTRA_MARKER_RE.search(marker) if marker else None
    gate_extra = gate_match.group(1).strip().lower() if gate_match else None
    return name, own_extras, gate_extra


def transitive_closure(roots: dict[str, set[str]]) -> set[str]:
    seen: set[str] = set()
    # (naam, actieve-extras-VOOR-dit-package) — dezelfde naam kan in theorie
    # met verschillende extra-sets in de wachtrij komen; visited houdt bij
    # welke (naam, extra)-combinaties al verwerkt zijn zodat er geen oneindige
    # lus ontstaat bij circulaire dependencies.
    queue: list[tuple[str, frozenset[str]]] = [(n, frozenset(e)) for n, e in roots.items()]
    visited: set[tuple[str, frozenset[str]]] = set()
    while queue:
        name, active_extras = queue.pop()
        key = (name, active_extras)
        if key in visited:
            continue
        visited.add(key)
        try:
            dist = importlib_metadata.distribution(name)
        except importlib_metadata.PackageNotFoundError:
            # Niet geïnstalleerd — bv. een optionele extra die genoemd wordt
            # maar (terecht) niet aangevraagd/geïnstalleerd is. Hoort dus niet
            # in de runtime-set, en negeren i.p.v. de hele run te laten falen,
            # zie §19 van de opdracht ("foutafhandeling... malformed
            # metadata").
            continue
        seen.add(name)
        for req in dist.requires or []:
            req_name, req_own_extras, gate_extra = parse_requirement_string(req)
            if not req_name:
                continue
            if gate_extra is not None and gate_extra not in active_extras:
                # Achter een "; extra == '...'" verstopt die HIER niet is
                # aangevraagd (bv. fastapi's "standard"/"all"-extra, terwijl
                # requirements.txt gewoon "fastapi==..." zonder extras heeft)
                # — niet meenemen, dat zou dev-only tools als httpx/pytest die
                # zo'n extra toevallig noemt onterecht als runtime bestempelen.
                continue
            queue.append((req_name, frozenset(req_own_extras)))
    return seen


def main() -> None:
    if len(sys.argv) != 3:
        print("Gebruik: sbom_python_scope.py <requirements.txt> <venv-pad (informatief)>", file=sys.stderr)
        sys.exit(2)
    requirements_path = sys.argv[1]
    roots = parse_requirement_roots(requirements_path)
    runtime_names = transitive_closure(roots)
    print(json.dumps({"runtimeNames": sorted(runtime_names)}))


if __name__ == "__main__":
    main()

"""JPype's JVM (gestart via app/mpp_converter.py._ensure_jvm, voor de
.mpp-import-tests in test_main.py::TestParseMpp) start achtergrondthreads die
na afloop van de laatste test het Python-proces open houden — een bekende
eigenschap van JPype zelf (shutdownJVM() blijkt dat niet betrouwbaar op te
lossen), geen bug in deze code. Zonder ingrijpen hangt `pytest` na de laatste
test i.p.v. netjes af te sluiten. pytest heeft op het moment van
pytest_sessionfinish alle testresultaten al gerapporteerd, dus een geforceerde
proces-exit hier is veilig — en alleen nodig als de JVM daadwerkelijk gestart
is (dus niet op een machine zonder JRE, waar de .mpp-tests zichzelf al
overslaan)."""
from __future__ import annotations

import os


def pytest_sessionfinish(session, exitstatus):  # noqa: ARG001
    try:
        import mpxj
    except ImportError:
        return
    if mpxj.isJVMStarted():
        os._exit(int(exitstatus))

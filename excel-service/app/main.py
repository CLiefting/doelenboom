"""
Doelenboom excel-service — Python/FastAPI microservice die
FPBB_doelenboom_referentietabel_*.xlsx-uploads parseert, opschoont en valideert.

Schrijft zelf niets naar de database — geeft alleen {status, report, parsed}
terug. De Node/Express-API (routes/imports.ts) bewaart dit als een "import" met
status 'pending', laat de gebruiker het rapport bekijken, en zet het pas via een
aparte /publish-stap daadwerkelijk in de doelenboom-tabellen (elements, edges, ...).
"""
from __future__ import annotations

from typing import Any, Literal

from fastapi import Body, FastAPI, File, Query, UploadFile
from fastapi.responses import JSONResponse, Response

from .exporter import build_data_workbook, build_template_workbook, is_standard_columns
from .parser import parse_workbook

app = FastAPI(title='doelenboom-excel-service', version='0.1.0')

XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'


@app.get('/health')
def health():
    return {'status': 'ok'}


@app.post('/parse')
async def parse(file: UploadFile = File(...), valid_types: list[str] = Query(default=[])):
    content = await file.read()
    if not content:
        return JSONResponse(status_code=400, content={
            'status': 'failed',
            'report': {
                'errors': ['Leeg bestand ontvangen.'], 'warnings': [],
                'counts': {}, 'sheetsFound': [], 'sheetsMissing': [],
            },
            'parsed': None,
        })

    # valid_types komt van routes/imports.ts (de kolomconfiguratie van de
    # doelenboom waarin geïmporteerd wordt, zie api/src/columnConfig.ts) —
    # zonder dit (lege lijst, bv. een oudere/losse aanroep) valt parse_workbook
    # terug op de vaste set van de 8 standaardtypes (zie parser.py).
    status, report, parsed = parse_workbook(
        content, filename=file.filename or '', valid_types=valid_types or None
    )
    return {'status': status, 'report': report, 'parsed': parsed}


@app.post('/export')
async def export(
    format: Literal['oud', 'nieuw'] = Query('oud'),
    mode: Literal['template', 'data'] = Query('data'),
    body: dict[str, Any] = Body(...),
):
    tree = body.get('tree')
    meta = body.get('meta') or {}
    # Kolomconfiguratie van de doelenboom (zie api/src/columnConfig.ts) — bij
    # mode=data zit die ook al in tree['columns'], maar bij mode=template is er
    # geen tree en moet de aanroeper 'm apart meegeven (nodig voor de dynamische
    # Type-dropdown/validatielijst in het 'nieuw' formaat, zie exporter.py).
    columns = body.get('columns') or (tree or {}).get('columns') or []

    if format == 'oud' and not is_standard_columns(columns):
        return JSONResponse(status_code=409, content={
            'error': (
                'Het "oud" Excel-formaat werkt alleen zolang de kolommen van deze doelenboom nog exact de '
                '8 standaardkolommen zijn. Deze doelenboom heeft een aangepaste kolomconfiguratie — gebruik '
                'het "nieuw" formaat.'
            ),
        })

    if mode == 'template':
        content = build_template_workbook(format, meta, columns=columns)
    else:
        if tree is None:
            return JSONResponse(status_code=400, content={'error': 'mode=data vereist een "tree" in de body.'})
        content = build_data_workbook(format, tree, meta, columns=columns)

    filename = f'doelenboom_{format}_{mode}.xlsx'
    return Response(
        content=content,
        media_type=XLSX_MEDIA_TYPE,
        headers={'Content-Disposition': f'attachment; filename="{filename}"'},
    )

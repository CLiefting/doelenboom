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

from .exporter import build_data_workbook, build_template_workbook
from .parser import parse_workbook

app = FastAPI(title='doelenboom-excel-service', version='0.1.0')

XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'


@app.get('/health')
def health():
    return {'status': 'ok'}


@app.post('/parse')
async def parse(file: UploadFile = File(...)):
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

    status, report, parsed = parse_workbook(content, filename=file.filename or '')
    return {'status': status, 'report': report, 'parsed': parsed}


@app.post('/export')
async def export(
    format: Literal['oud', 'nieuw'] = Query('oud'),
    mode: Literal['template', 'data'] = Query('data'),
    body: dict[str, Any] = Body(...),
):
    tree = body.get('tree')
    meta = body.get('meta') or {}

    if mode == 'template':
        content = build_template_workbook(format, meta)
    else:
        if tree is None:
            return JSONResponse(status_code=400, content={'error': 'mode=data vereist een "tree" in de body.'})
        content = build_data_workbook(format, tree, meta)

    filename = f'doelenboom_{format}_{mode}.xlsx'
    return Response(
        content=content,
        media_type=XLSX_MEDIA_TYPE,
        headers={'Content-Disposition': f'attachment; filename="{filename}"'},
    )

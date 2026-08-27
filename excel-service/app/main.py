"""
Doelenboom excel-service — Python/FastAPI microservice die
FPBB_doelenboom_referentietabel_*.xlsx-uploads parseert, opschoont en valideert,
én (zie /parse-mpp) .mpp-bestanden (MS Project) omzet naar MS Project XML.

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
from .mpp_converter import MppConversionError, mpp_to_mspdi_xml
from .parser import parse_workbook
from .project_workbook import build_project_workbook, parse_project_workbook

app = FastAPI(title='doelenboom-excel-service', version='0.1.0')

XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
MSPDI_MEDIA_TYPE = 'application/xml'


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


@app.post('/parse-mpp')
async def parse_mpp(file: UploadFile = File(...)):
    """Zet een geüpload .mpp-bestand om naar MS Project XML (zie
    mpp_converter.py) en geeft die XML-tekst terug — puur een
    formaat-conversie, geen taken-filtering/-mapping (dat gebeurt in
    tree.html, met dezelfde parseMppProjectXml() als bij een rechtstreeks
    aangeleverde XML-export). Aangeroepen door
    api/src/routes/activities.ts (POST .../activities/import-mpp)."""
    content = await file.read()
    if not content:
        return JSONResponse(status_code=400, content={'error': 'Leeg bestand ontvangen.'})
    try:
        xml_text = mpp_to_mspdi_xml(content)
    except MppConversionError as exc:
        return JSONResponse(status_code=400, content={
            'error': 'Kon het .mpp-bestand niet lezen. Is dit een geldig MS Project-bestand?',
            'detail': str(exc),
        })
    return Response(content=xml_text, media_type=MSPDI_MEDIA_TYPE)


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


@app.post('/project-export')
async def project_export(body: dict[str, Any] = Body(...)):
    """Bouwt het Project/Producten/Activiteiten-Excel-bestand voor één project
    (zie project_workbook.py) — aangeroepen door
    api/src/routes/projectExcel.ts (GET .../elements/:code/project-export),
    dat de data van dat ene project (uit fetchTree) hier als JSON aanlevert."""
    data = body.get('data') or {}
    meta = body.get('meta') or {}
    content = build_project_workbook(data, meta)
    project_code = (data.get('project') or {}).get('code') or 'project'
    filename = f'Project_{project_code}.xlsx'
    return Response(
        content=content,
        media_type=XLSX_MEDIA_TYPE,
        headers={'Content-Disposition': f'attachment; filename="{filename}"'},
    )


@app.post('/project-parse')
async def project_parse(file: UploadFile = File(...)):
    """Leest een geüpload Project-Excel-bestand (export van /project-export,
    eventueel bewerkt) en geeft de rauwe, geparste rijen terug — geen
    create/update/delete-logica hier, dat gebeurt client-side
    (computeProjectImportPlan in tree.html) tegen de al geladen PRODUCTS/
    ACTIVITIES/PROJECT_STATUS van dit project. Aangeroepen door
    api/src/routes/projectExcel.ts (POST .../elements/:code/project-import-parse)."""
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
    status, report, parsed = parse_project_workbook(content)
    return {'status': status, 'report': report, 'parsed': parsed}

"""
Eén centrale plek voor de "Excel-exportformaatversie" die in élke .xlsx-export
van deze service wordt weggeschreven (Configuratie-tab in exporter.py,
Info-tab in project_workbook.py) — een simpel, handmatig opgehoogd versienummer
van de TABBLADSTRUCTUUR/KOLOMKOPPEN van dat ene exportformaat, niet de
applicatie-versie zelf (die verandert veel vaker, bij elke deploy, en zegt
niets over of een oud bestand nog leesbaar is).

Waarom dit nodig is: een geëxporteerd .xlsx-bestand kan jaren later, door een
toekomstige versie van deze parser, weer geïmporteerd worden (zie
parse_workbook in parser.py en parse_project_workbook in project_workbook.py)
— als de tabbladstructuur of kolomkoppen ondertussen zijn veranderd, moet de
parser dat kunnen herkennen i.p.v. stilzwijgend verkeerd te lezen. Dit
versienummer staat dus niet voor niets in elk bestand: het is de haak waarmee
een latere parser kan beslissen "dit is een oud bestand, lees het zus" of "dit
bestand is nieuwer dan ik snap, waarschuw de gebruiker". Vandaag bestaat die
vertakking nog niet (er is nog maar één versie per formaat) — parse_workbook/
parse_project_workbook lezen 'm al wel uit en geven 'm terug in het rapport
(report['formatVersion']), puur informatief, zodat 'm zichtbaar is bij het
uitzoeken van een importprobleem zonder het bestand zelf te hoeven openen.

Ophogen: verhoog het bijbehorende versienummer zodra je een BESTAANDE kolom/
tabblad van dat exportformaat hernoemt, verwijdert, of van betekenis laat
veranderen. Een nieuwe kolom/tabblad TOEVOEGEN aan het einde is meestal geen
breaking change (oudere/huidige parsers negeren onbekende kolommen) en hoeft
niet per se een ophoging te zijn, maar doe het bij twijfel toch — de losse
per-formaat versies houden elkaar niet tegen, dus dat is goedkoop.
"""

# "Volledige boom"-export (exporter.py: build_template_workbook/
# build_data_workbook, POST /export — beide formaten 'oud'/'nieuw' delen dit
# ene versienummer, ook al verschillen hun tabbladstructuren onderling; ze
# worden altijd samen aangepast in exporter.py/parser.py).
TREE_EXPORT_FORMAT_VERSION = '1.0'

# Eén-project-export (project_workbook.py: build_project_workbook /
# POST /project-export, weer ingelezen door parse_project_workbook).
PROJECT_EXPORT_FORMAT_VERSION = '1.0'

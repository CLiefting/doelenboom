"""
Bescherming tegen formule-injectie in gegenereerde .xlsx-exports
(CISO-aandachtspunt).

openpyxl promoveert een plain-tekstwaarde die met '=' begint automatisch tot
een ECHTE formulecel (data_type 'f', met een <f>-tag in de opgeslagen XML) —
geverifieerd door een testbestand te genereren en de ruwe sheet-XML te
inspecteren: waarde '=1+1' resulteert in <c r="A1"><f>1+1</f><v></v></c>,
i.e. Excel evalueert deze daadwerkelijk automatisch bij het openen, dit is
geen kwestie van Excel die tekst "toevallig net zo interpreteert". Elke tekst
die in een export terechtkomt kan uit door tenants/gebruikers ingevoerde
velden komen (elementnaam, -omschrijving, tag/organisatienaam, toelichting,
...) — dus zonder deze sanitisatie kan iemand met alleen schrijfrechten op
één doelenboom een cel met bv. '=WEBSERVICE(...)' laten binnensluipen in een
export die een ANDERE (hogere-rechten-)gebruiker later opent.

Mitigatie volgens de OWASP-CSV/formule-injectie-aanbeveling: een cel die met
=, +, -, @, Tab (0x09) of CR (0x0D) begint krijgt een voorloop-apostrof
('), zodat openpyxl 'm als platte tekst opslaat i.p.v. als formule. Dat
voorloop-teken blijft (anders dan bij een door een mens in Excel zélf
getypte cel) zichtbaar in de cel — bewuste, geaccepteerde afweging: liever
een zichtbaar escape-teken dan een automatisch uitgevoerde formule.
"""
from __future__ import annotations

_TRIGGER_CHARS = ('=', '+', '-', '@', '\t', '\r')


def sanitize_cell(value: object) -> object:
    """Geeft `value` terug, met een voorloop-apostrof als het een string is
    die met een formule-triggerend teken begint. Niet-strings (getallen,
    None, datums, ...) gaan ongewijzigd door."""
    if isinstance(value, str) and value.startswith(_TRIGGER_CHARS):
        return "'" + value
    return value


def sanitize_row(values: list) -> list:
    """sanitize_cell() toegepast op elke waarde in een rij — voor gebruik
    vlak vóór ws.append([...])."""
    return [sanitize_cell(v) for v in values]


def create_safe_sheet(wb, *args, **kwargs):
    """Drop-in vervanging voor `wb.create_sheet(...)`: geeft hetzelfde
    Worksheet terug, maar met `.append()` vervangen door een variant die elke
    rij eerst door sanitize_row() haalt. Zo hoeft geen enkele aanroepplek
    (nu of later toegevoegd) zich apart aan de sanitisatie te houden — één
    plek (hier `create_sheet` i.p.v. elke losse `.append(...)`) garandeert
    volledige dekking."""
    ws = wb.create_sheet(*args, **kwargs)
    original_append = ws.append

    def safe_append(row, *a, **kw):
        if isinstance(row, (list, tuple)):
            row = sanitize_row(list(row))
        return original_append(row, *a, **kw)

    ws.append = safe_append
    return ws

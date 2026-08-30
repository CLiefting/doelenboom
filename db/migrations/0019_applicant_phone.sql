-- Telefoonnummer bij een abonnementsaanvraag — zie doelenboom_licentiemodel.md
-- §9 en het verzoek van Charles (30 augustus 2026): in het nieuwe sorteerbare
-- abonnementenoverzicht (naast Tenantbeheer) wil hij per tenant ook het
-- telefoonnummer van de aanvrager kunnen zien. Bewust NULLABLE en niet
-- verplicht op het aanvraagformulier — bestaande aanvragen hebben er geen,
-- en niet elke organisatie wil een telefoonnummer opgeven.
alter table subscription_requests add column if not exists applicant_phone text;

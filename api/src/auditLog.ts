import { pool } from './db.js';

// Generiek auditlog-hulpje — zie db/init.sql (audit_log) voor de tabel en het
// datamodel-commentaar daar over de gekozen event_types. Bewust een losse,
// altijd-awaited helper (geen fire-and-forget) zodat een testcase de logregel
// betrouwbaar meteen na de request kan controleren, maar wel zelf try/catch
// om de aanroeper: een auditlog-schrijffout mag de "echte" actie (boom tonen,
// tenant-instellingen opslaan) nooit laten mislukken.
export type AuditEventType =
  | 'doelenboom_view'
  | 'tenant_settings_changed'
  | 'mfa_verified'
  | 'mfa_failed'
  | 'tenant_contact_changed'
  | 'tenant_customer_info_changed'
  | 'tenant_subscription_changed'
  // Automatisch/bij uitloggen leegmaken van een doelenboom (DOEL-28); userId is
  // null bij de periodieke sweep.
  | 'doelenboom_wiped'
  // DOEL-29 (analyse M6): inloggen, wachtwoorden, gebruikers/leden, export/import.
  // userId = de ACTOR (bij login_failed/account_locked op een bekend account: het
  // account zelf; bij een onbekend adres null); het doelwit staat in detail.
  | 'login_success'
  | 'login_failed'
  | 'account_locked'
  | 'password_changed'
  | 'password_reset'
  | 'user_created'
  | 'user_updated'
  | 'user_deleted'
  | 'tenant_member_changed'
  | 'doelenboom_deleted'
  | 'doelenboom_exported'
  | 'doelenboom_import_published'
  // DOEL-62: controleregels gewijzigd (doelenboom, tenant-default of
  // sjabloon). detail = { scope, templateId?, ruleCount, ruleIds } — bewust
  // NOOIT labels/uitleg: die zijn vrije tekst van de gebruiker.
  | 'control_rules_updated'
  // DOEL-64: gemotiveerde afwijking van een controleregel gezet/ingetrokken.
  // detail = { elementCode, ruleId } — bewust NOOIT de motivatietekst.
  | 'control_rule_deviation_set'
  | 'control_rule_deviation_removed'
  // DOEL-70: mail aan sysadmins over nieuwe kwetsbaarheden in
  // softwarecomponenten. detail = alleen aantallen (per ernst, ontvangers,
  // verstuurd) — nooit pakketnamen, kwetsbaarheid-id's of e-mailadressen.
  | 'dependency_vulnerability_alert_sent'
  // DOEL-75: kenmerkdefinities gewijzigd (doelenboom, tenant-default of
  // sjabloon). detail = { scope, templateId?, attributeCount, attributeIds }
  // — bewust NOOIT labels, uitleg of keuzelijstwaarden (vrije tekst).
  | 'attribute_definitions_updated'
  // DOEL-82: meerdere elementen in één keer verwijderd. detail = { count,
  // codes } — bewust NOOIT namen of andere vrije tekst van de elementen.
  | 'elements_bulk_deleted';

export interface LogAuditEventInput {
  eventType: AuditEventType;
  userId?: string | number | null;
  tenantId?: string | number | null;
  doelenboomId?: string | number | null;
  role?: string | null;
  detail?: Record<string, unknown>;
}

export async function logAuditEvent(input: LogAuditEventInput): Promise<void> {
  try {
    await pool.query(
      `insert into audit_log (event_type, user_id, tenant_id, doelenboom_id, role, detail)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        input.eventType,
        input.userId ?? null,
        input.tenantId ?? null,
        input.doelenboomId ?? null,
        input.role ?? null,
        JSON.stringify(input.detail ?? {}),
      ]
    );
  } catch (err) {
    console.error('Kon auditlogregel niet wegschrijven (actie zelf gaat gewoon door):', err);
  }
}

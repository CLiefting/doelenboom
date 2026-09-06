import { Fragment, FormEvent, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type {
  AuditLogEntry,
  ModuleDef,
  Tier,
  TenantAuditLogEntry,
  TenantContact,
  TenantContactRole,
  TenantContractStatus,
  TenantCustomerInfo,
  TenantHealth,
  TenantLicense,
  TenantSummary,
} from '../types';

// Klantbeheer (sysadmin-only) — zie Charles' verzoek: "wie is de klant (ID),
// naam, klant sinds, primair contact (incl history) en wie zijn de overige
// contacten, per rol (tenant admin, tenant ciso)" plus "een overzicht van de
// abonnementen in een list view, uitklapbaar voor meer details", en de drie
// aanvullingen die hij daarna koos (facturatie-/bedrijfsgegevens, tags/
// segmentatie, contractreferentie; wijzigingslog, verlengingsherinnering,
// klantgezondheid — zie api/src/routes/customerManagement.ts).
//
// Eén rij per tenant ("klant"), uitklapbaar voor het volledige contact-/
// klantgegevens-/abonnementenbeeld — zelfde interactiepatroon als
// SubscriptionOverviewPage.tsx, maar inline uitklappend i.p.v. een modal
// (Charles vroeg expliciet om een "uitklapbare list view").
const CONTACT_ROLE_LABEL: Record<TenantContactRole, string> = {
  tenant_admin: 'Tenant-admin',
  ciso: 'CISO',
  overig: 'Overig',
};

// Status van het CONTRACT VAN DE KLANT ZELF — puur informatief (zie
// db/migrations/0035_subscription_cancellation.sql), analoog aan maar los van
// de opzegging van "ons" abonnement (SubscriptionPanel hieronder).
const CONTRACT_STATUS_LABEL: Record<TenantContractStatus, string> = {
  lopend: 'Lopend',
  opgezegd: 'Opgezegd',
  beeindigd: 'Beëindigd',
};

const HEALTH_LABEL: Record<TenantHealth['status'], { label: string; color: string; bg: string }> = {
  gezond: { label: 'Gezond', color: '#1e6b34', bg: '#e6f4ea' },
  aandacht: { label: 'Aandacht', color: '#8a5a00', bg: '#fdf1da' },
  risico: { label: 'Risico', color: '#7A1F1F', bg: '#FBE8E8' },
};

export default function KlantbeheerPage({ token, onBack }: { token: string; onBack: () => void }) {
  const [tenants, setTenants] = useState<TenantSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // Primair contact + klantgegevens worden per rij vast even opgehaald (niet
  // pas bij uitklappen) — dit zijn de kolommen die Charles direct in de
  // lijst wil zien ("wie is de klant, naam, klant sinds, primair contact").
  const [primaryContacts, setPrimaryContacts] = useState<Record<number, TenantContact | null>>({});
  const [customerSinceByTenant, setCustomerSinceByTenant] = useState<Record<number, string | null>>({});
  const [customerNumberByTenant, setCustomerNumberByTenant] = useState<Record<number, number | null>>({});
  const [healthByTenant, setHealthByTenant] = useState<Record<number, TenantHealth | null>>({});

  function load() {
    api.tenants(token).then(setTenants).catch((err) => setError(errMsg(err)));
  }
  useEffect(load, [token]);

  // Eén keer per tenant, parallel — voor dit soort intern beheerscherm (een
  // handvol tot enkele tientallen tenants) is losse ophaal per rij prima; een
  // apart bulk-overzicht-endpoint zoals subscriptionOverview zou hier
  // overkill zijn voor drie simpele velden.
  useEffect(() => {
    if (!tenants) return;
    for (const t of tenants) {
      api.tenantContacts(token, t.id)
        .then((contacts) => setPrimaryContacts((m) => ({ ...m, [t.id]: contacts.find((c) => c.isPrimary) ?? null })))
        .catch(() => setPrimaryContacts((m) => ({ ...m, [t.id]: null })));
      api.tenantCustomerInfo(token, t.id)
        .then((info) => {
          setCustomerSinceByTenant((m) => ({ ...m, [t.id]: info.customerSince }));
          setCustomerNumberByTenant((m) => ({ ...m, [t.id]: info.customerNumber }));
        })
        .catch(() => {
          setCustomerSinceByTenant((m) => ({ ...m, [t.id]: null }));
          setCustomerNumberByTenant((m) => ({ ...m, [t.id]: null }));
        });
      api.tenantHealth(token, t.id)
        .then((h) => setHealthByTenant((m) => ({ ...m, [t.id]: h })))
        .catch(() => setHealthByTenant((m) => ({ ...m, [t.id]: null })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenants, token]);

  const visibleTenants = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tenants ?? [];
    return (tenants ?? []).filter(
      (t) => t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q) || String(t.id).includes(q)
    );
  }, [tenants, query]);

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Klantbeheer</h1>
          <p style={styles.subtitle}>
            Contactpersonen, klantgegevens en abonnementen per tenant — klik op een rij voor het volledige beeld.
          </p>
        </div>
        <button onClick={onBack} style={btnStyle('ghost')}>← Terug</button>
      </header>

      {error && <p style={styles.error}>{error}</p>}
      {!tenants && !error && <p style={styles.muted}>Laden…</p>}

      {tenants && (
        <section style={styles.section}>
          <input
            style={styles.search}
            placeholder="Zoek op klant-ID, naam of slug…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>ID</th>
                  <th style={styles.th}>Klantnummer</th>
                  <th style={styles.th}>Klant</th>
                  <th style={styles.th}>Klant sinds</th>
                  <th style={styles.th}>Primair contact</th>
                  <th style={styles.th}>Status</th>
                  <th style={{ ...styles.th, cursor: 'default' }}></th>
                </tr>
              </thead>
              <tbody>
                {visibleTenants.map((t) => {
                  const isExpanded = expandedId === t.id;
                  const primary = primaryContacts[t.id];
                  const customerSince = customerSinceByTenant[t.id];
                  const customerNumber = customerNumberByTenant[t.id];
                  const health = healthByTenant[t.id];
                  return (
                    <Fragment key={t.id}>
                      <tr
                        style={styles.rowClickable}
                        onClick={() => setExpandedId(isExpanded ? null : t.id)}
                      >
                        <td style={styles.td}>{t.id}</td>
                        <td style={styles.td}>{customerNumber ?? <span style={styles.muted}>—</span>}</td>
                        <td style={styles.td}>
                          <strong>{t.name}</strong>
                          <div style={styles.tenantSlug}>{t.slug}</div>
                          {t.terminated_at && <span style={styles.terminatedBadge}>beëindigd</span>}
                        </td>
                        <td style={styles.td}>{customerSince ? formatDateNL(customerSince) : '—'}</td>
                        <td style={styles.td}>
                          {primary ? (
                            <>
                              <div>{primary.name}</div>
                              <div style={styles.tenantSlug}>
                                {CONTACT_ROLE_LABEL[primary.role]} · {primary.email}
                              </div>
                            </>
                          ) : (
                            <span style={styles.muted}>— geen primair contact —</span>
                          )}
                        </td>
                        <td style={styles.td}>
                          {health ? (
                            <span
                              style={{
                                ...styles.healthBadge,
                                color: HEALTH_LABEL[health.status].color,
                                background: HEALTH_LABEL[health.status].bg,
                              }}
                              title={health.reasons.join(' ')}
                            >
                              {HEALTH_LABEL[health.status].label}
                            </span>
                          ) : (
                            <span style={styles.muted}>…</span>
                          )}
                        </td>
                        <td style={{ ...styles.td, textAlign: 'right' }}>
                          <span style={styles.chevron}>{isExpanded ? '▲' : '▼'}</span>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td style={styles.detailCell} colSpan={7}>
                            <CustomerDetail
                              token={token}
                              tenant={t}
                              onContactsChanged={() => {
                                api.tenantContacts(token, t.id)
                                  .then((contacts) => setPrimaryContacts((m) => ({ ...m, [t.id]: contacts.find((c) => c.isPrimary) ?? null })))
                                  .catch(() => {});
                              }}
                              onCustomerInfoChanged={(info) => {
                                setCustomerSinceByTenant((m) => ({ ...m, [t.id]: info.customerSince }));
                                setCustomerNumberByTenant((m) => ({ ...m, [t.id]: info.customerNumber }));
                              }}
                              onHealthRefresh={(h) => setHealthByTenant((m) => ({ ...m, [t.id]: h }))}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {visibleTenants.length === 0 && (
                  <tr>
                    <td style={styles.td} colSpan={7}>
                      <span style={styles.muted}>Geen tenants gevonden.</span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}

// --- Uitgeklapte detailweergave van één klant ---

function CustomerDetail({
  token,
  tenant,
  onContactsChanged,
  onCustomerInfoChanged,
  onHealthRefresh,
}: {
  token: string;
  tenant: TenantSummary;
  onContactsChanged: () => void;
  onCustomerInfoChanged: (info: TenantCustomerInfo) => void;
  onHealthRefresh: (h: TenantHealth) => void;
}) {
  const [contacts, setContacts] = useState<TenantContact[] | null>(null);
  const [customerInfo, setCustomerInfo] = useState<TenantCustomerInfo | null>(null);
  const [health, setHealth] = useState<TenantHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAddContact, setShowAddContact] = useState(false);
  const [editingContact, setEditingContact] = useState<TenantContact | null>(null);
  const [showContactHistory, setShowContactHistory] = useState(false);
  const [showSubscriptionHistory, setShowSubscriptionHistory] = useState(false);

  function loadContacts() {
    api.tenantContacts(token, tenant.id).then(setContacts).catch((err) => setError(errMsg(err)));
  }

  useEffect(() => {
    loadContacts();
    api.tenantCustomerInfo(token, tenant.id).then(setCustomerInfo).catch((err) => setError(errMsg(err)));
    api.tenantHealth(token, tenant.id).then((h) => {
      setHealth(h);
      onHealthRefresh(h);
    }).catch((err) => setError(errMsg(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, tenant.id]);

  const byRole = useMemo(() => {
    const groups: Record<TenantContactRole, TenantContact[]> = { tenant_admin: [], ciso: [], overig: [] };
    for (const c of contacts ?? []) groups[c.role].push(c);
    return groups;
  }, [contacts]);

  async function handleDeleteContact(contact: TenantContact) {
    if (!window.confirm(`Contactpersoon "${contact.name}" verwijderen?`)) return;
    try {
      await api.deleteTenantContact(token, contact.id);
      loadContacts();
      onContactsChanged();
    } catch (err) {
      setError(errMsg(err));
    }
  }

  return (
    <div style={styles.detailGrid}>
      {error && <p style={styles.error}>{error}</p>}

      <div style={styles.detailColumn}>
        <div style={styles.detailHeaderRow}>
          <h3 style={styles.h3}>Contactpersonen</h3>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={btnStyle('ghost')} onClick={() => setShowContactHistory((v) => !v)}>
              {showContactHistory ? 'Geschiedenis verbergen' : 'Geschiedenis'}
            </button>
            <button style={btnStyle('primary')} onClick={() => setShowAddContact(true)}>+ Contact</button>
          </div>
        </div>

        {!contacts && <p style={styles.muted}>Laden…</p>}
        {contacts && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(['tenant_admin', 'ciso', 'overig'] as TenantContactRole[]).map((role) => (
              <div key={role}>
                <div style={styles.roleLabel}>{CONTACT_ROLE_LABEL[role]}</div>
                {byRole[role].length === 0 && <p style={styles.muted}>— geen —</p>}
                {byRole[role].map((c) => (
                  <div key={c.id} style={styles.contactRow}>
                    <div>
                      <strong>{c.name}</strong>
                      {c.isPrimary && <span style={styles.primaryBadge}>primair</span>}
                      <div style={styles.tenantSlug}>{c.email}{c.phone ? ` · ${c.phone}` : ''}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button style={btnStyle('ghost')} onClick={() => setEditingContact(c)}>Bewerken</button>
                      <button style={btnStyle('danger')} onClick={() => handleDeleteContact(c)}>Verwijderen</button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {showContactHistory && <ContactHistory token={token} tenantId={tenant.id} />}
      </div>

      <div style={styles.detailColumn}>
        <h3 style={styles.h3}>Klantgegevens</h3>
        {!customerInfo && <p style={styles.muted}>Laden…</p>}
        {customerInfo && (
          <CustomerInfoForm
            token={token}
            tenantId={tenant.id}
            info={customerInfo}
            onSaved={(info) => {
              setCustomerInfo(info);
              onCustomerInfoChanged(info);
            }}
          />
        )}
      </div>

      <div style={styles.detailColumn}>
        <div style={styles.detailHeaderRow}>
          <h3 style={styles.h3}>Abonnement</h3>
          <button style={btnStyle('ghost')} onClick={() => setShowSubscriptionHistory((v) => !v)}>
            {showSubscriptionHistory ? 'Wijzigingslog verbergen' : 'Wijzigingslog'}
          </button>
        </div>

        {health && (
          <div style={{ marginBottom: 10 }}>
            <span
              style={{
                ...styles.healthBadge,
                color: HEALTH_LABEL[health.status].color,
                background: HEALTH_LABEL[health.status].bg,
              }}
            >
              {HEALTH_LABEL[health.status].label}
            </span>
            <ul style={styles.reasonsList}>
              {health.reasons.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
            {health.usage && (
              <p style={styles.muted}>
                Gebruik: {health.usage.activeAdmins}/{health.usage.maxAdmins ?? '∞'} admins,{' '}
                {health.usage.activeBomen}/{health.usage.maxBomen ?? '∞'} doelenbomen.
                {health.daysSinceActivity != null && ` Laatste activiteit ${health.daysSinceActivity} dag(en) geleden.`}
              </p>
            )}
          </div>
        )}

        <SubscriptionPanel
          token={token}
          tenantId={tenant.id}
          onChanged={() => {
            api.tenantHealth(token, tenant.id).then((h) => {
              setHealth(h);
              onHealthRefresh(h);
            }).catch(() => {});
          }}
        />

        {showSubscriptionHistory && <SubscriptionHistory token={token} tenantId={tenant.id} />}
      </div>

      {showAddContact && (
        <ContactModal
          token={token}
          tenantId={tenant.id}
          onClose={() => setShowAddContact(false)}
          onSaved={() => {
            setShowAddContact(false);
            loadContacts();
            onContactsChanged();
          }}
        />
      )}
      {editingContact && (
        <ContactModal
          token={token}
          tenantId={tenant.id}
          existing={editingContact}
          onClose={() => setEditingContact(null)}
          onSaved={() => {
            setEditingContact(null);
            loadContacts();
            onContactsChanged();
          }}
        />
      )}
    </div>
  );
}

// --- Contactpersoon toevoegen/bewerken ---

function ContactModal({
  token,
  tenantId,
  existing,
  onClose,
  onSaved,
}: {
  token: string;
  tenantId: number;
  existing?: TenantContact;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [email, setEmail] = useState(existing?.email ?? '');
  const [phone, setPhone] = useState(existing?.phone ?? '');
  const [role, setRole] = useState<TenantContactRole>(existing?.role ?? 'overig');
  const [isPrimary, setIsPrimary] = useState(existing?.isPrimary ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = { name: name.trim(), email: email.trim(), phone: phone.trim() || null, role, isPrimary };
      if (existing) {
        await api.updateTenantContact(token, existing.id, body);
      } else {
        await api.createTenantContact(token, tenantId, body);
      }
      onSaved();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.overlay} onClick={onClose}>
      <form style={styles.modal} onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <h2 style={styles.h2}>{existing ? 'Contact bewerken' : 'Nieuw contact'}</h2>
        {error && <p style={styles.error}>{error}</p>}

        <label style={styles.label}>
          Naam
          <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label style={styles.label}>
          E-mail
          <input style={styles.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label style={styles.label}>
          Telefoon
          <input style={styles.input} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <label style={styles.label}>
          Rol
          <select style={styles.input} value={role} onChange={(e) => setRole(e.target.value as TenantContactRole)}>
            {(Object.keys(CONTACT_ROLE_LABEL) as TenantContactRole[]).map((r) => (
              <option key={r} value={r}>{CONTACT_ROLE_LABEL[r]}</option>
            ))}
          </select>
        </label>
        <label style={{ ...styles.label, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />
          Primair contact voor deze tenant
        </label>
        {isPrimary && (
          <p style={styles.hint}>
            Er kan maar één primair contact zijn — een eventueel huidig primair contact wordt automatisch teruggezet
            (de overdracht wordt bewaard in de geschiedenis).
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="submit" disabled={busy} style={btnStyle('primary')}>Opslaan</button>
          <button type="button" onClick={onClose} style={btnStyle('ghost')}>Annuleren</button>
        </div>
      </form>
    </div>
  );
}

// --- Primair-contact-/wijzigingsgeschiedenis (audit_log, tenant_contact_changed) ---

function ContactHistory({ token, tenantId }: { token: string; tenantId: number }) {
  const [entries, setEntries] = useState<TenantAuditLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.tenantContactsHistory(token, tenantId).then(setEntries).catch((err) => setError(errMsg(err)));
  }, [token, tenantId]);

  if (error) return <p style={styles.error}>{error}</p>;
  if (!entries) return <p style={styles.muted}>Laden…</p>;
  if (entries.length === 0) return <p style={styles.muted}>Nog geen wijzigingen gelogd.</p>;

  return (
    <div style={styles.historyBox}>
      {entries.map((e) => (
        <div key={e.id} style={styles.historyRow}>
          <div style={styles.historyMeta}>
            {formatDateTimeNL(e.createdAt)} — {e.userEmail ?? '(onbekend)'}
          </div>
          <div style={styles.historyDetail}>{describeContactChange(e.detail)}</div>
        </div>
      ))}
    </div>
  );
}

function describeContactChange(detail: Record<string, unknown>): string {
  const action = detail.action as string | undefined;
  const transfer = detail.primaryTransfer as { from: { name: string } | null; to: { name: string } } | undefined;
  const parts: string[] = [];
  if (action === 'created') parts.push('Contact aangemaakt.');
  else if (action === 'updated') parts.push('Contact bijgewerkt.');
  else if (action === 'deleted') parts.push('Contact verwijderd.');
  if (transfer) {
    parts.push(
      transfer.from
        ? `Primair contact overgedragen van "${transfer.from.name}" naar "${transfer.to.name}".`
        : `"${transfer.to.name}" is het primaire contact geworden.`
    );
  }
  return parts.join(' ') || JSON.stringify(detail);
}

// --- Klantgegevens (facturatie/tags/contractreferentie) ---

function CustomerInfoForm({
  token,
  tenantId,
  info,
  onSaved,
}: {
  token: string;
  tenantId: number;
  info: TenantCustomerInfo;
  onSaved: (info: TenantCustomerInfo) => void;
}) {
  const [customerSince, setCustomerSince] = useState(info.customerSince ?? '');
  const [kvkNumber, setKvkNumber] = useState(info.kvkNumber ?? '');
  const [vatNumber, setVatNumber] = useState(info.vatNumber ?? '');
  const [billingAddress, setBillingAddress] = useState(info.billingAddress ?? '');
  const [tagsInput, setTagsInput] = useState(info.tags.join(', '));
  const [contractReference, setContractReference] = useState(info.contractReference ?? '');
  const [contractDate, setContractDate] = useState(info.contractDate ?? '');
  const [contractUrl, setContractUrl] = useState(info.contractUrl ?? '');
  const [contractStatus, setContractStatus] = useState<TenantContractStatus>(info.contractStatus);
  const [customerNumber, setCustomerNumber] = useState(info.customerNumber != null ? String(info.customerNumber) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedNumber = customerNumber.trim();
    if (trimmedNumber && (!/^\d+$/.test(trimmedNumber) || Number(trimmedNumber) < 1)) {
      setError('Klantnummer moet een positief geheel getal zijn.');
      return;
    }
    setBusy(true);
    try {
      const saved = await api.updateTenantCustomerInfo(token, tenantId, {
        customerSince: customerSince || null,
        kvkNumber: kvkNumber.trim() || null,
        vatNumber: vatNumber.trim() || null,
        billingAddress: billingAddress.trim() || null,
        tags: tagsInput.split(',').map((t) => t.trim()).filter(Boolean),
        contractReference: contractReference.trim() || null,
        contractDate: contractDate || null,
        contractUrl: contractUrl.trim() || null,
        contractStatus,
        customerNumber: trimmedNumber ? Number(trimmedNumber) : null,
      });
      onSaved(saved);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {error && <p style={styles.error}>{error}</p>}
      <label style={styles.label}>
        Klantnummer
        <input
          style={styles.input}
          type="number"
          min={1}
          step={1}
          value={customerNumber}
          onChange={(e) => setCustomerNumber(e.target.value)}
          placeholder="bv. 1 (Liefting)"
        />
      </label>
      <label style={styles.label}>
        Klant sinds
        <input style={styles.input} type="date" value={customerSince} onChange={(e) => setCustomerSince(e.target.value)} />
      </label>
      <label style={styles.label}>
        KvK-nummer
        <input style={styles.input} value={kvkNumber} onChange={(e) => setKvkNumber(e.target.value)} />
      </label>
      <label style={styles.label}>
        Btw-nummer
        <input style={styles.input} value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} />
      </label>
      <label style={styles.label}>
        Factuuradres
        <textarea style={{ ...styles.input, minHeight: 50 }} value={billingAddress} onChange={(e) => setBillingAddress(e.target.value)} />
      </label>
      <label style={styles.label}>
        Tags (komma-gescheiden)
        <input style={styles.input} value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="bv. overheid, pilot" />
      </label>
      <label style={styles.label}>
        Contractreferentie
        <input style={styles.input} value={contractReference} onChange={(e) => setContractReference(e.target.value)} />
      </label>
      <label style={styles.label}>
        Contractdatum
        <input style={styles.input} type="date" value={contractDate} onChange={(e) => setContractDate(e.target.value)} />
      </label>
      <label style={styles.label}>
        Contract-URL
        <input style={styles.input} value={contractUrl} onChange={(e) => setContractUrl(e.target.value)} placeholder="https://…" />
      </label>
      <label style={styles.label}>
        Contractstatus
        <select style={styles.input} value={contractStatus} onChange={(e) => setContractStatus(e.target.value as TenantContractStatus)}>
          {(Object.keys(CONTRACT_STATUS_LABEL) as TenantContractStatus[]).map((s) => (
            <option key={s} value={s}>{CONTRACT_STATUS_LABEL[s]}</option>
          ))}
        </select>
      </label>
      <p style={styles.hint}>
        Puur informatief (contract van de klant zelf) — heeft geen effect op de toegang van de tenant.
        Dat regelt de opzegging van het abonnement hiernaast.
      </p>
      <button type="submit" disabled={busy} style={{ ...btnStyle('primary'), alignSelf: 'flex-start' }}>Opslaan</button>
    </form>
  );
}

// --- Abonnement: huidig tier/einddatum/modules (hergebruikt dezelfde
// sysadmin-only endpoints als TenantLicensePanel.tsx, maar compacter). ---

function SubscriptionPanel({ token, tenantId, onChanged }: { token: string; tenantId: number; onChanged: () => void }) {
  const [license, setLicense] = useState<TenantLicense | null>(null);
  const [tiers, setTiers] = useState<Tier[] | null>(null);
  const [modules, setModules] = useState<ModuleDef[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.tenantLicense(token, tenantId).then(setLicense).catch((err) => setError(errMsg(err)));
  }
  useEffect(() => {
    load();
    api.tiers(token).then(setTiers).catch((err) => setError(errMsg(err)));
    api.modules(token).then(setModules).catch((err) => setError(errMsg(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, tenantId]);

  async function changeTier(tierId: number | null) {
    setBusy(true);
    setError(null);
    try {
      setLicense(await api.setTenantTier(token, tenantId, tierId));
      onChanged();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleModule(moduleKey: string, active: boolean) {
    setBusy(true);
    setError(null);
    try {
      setLicense(await api.setTenantModule(token, tenantId, moduleKey, active));
      onChanged();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function changeEndDate(endDate: string | null) {
    setBusy(true);
    setError(null);
    try {
      setLicense(await api.setTenantLicenseEndDate(token, tenantId, endDate));
      onChanged();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleCancelled(cancelled: boolean) {
    setBusy(true);
    setError(null);
    try {
      setLicense(await api.setTenantSubscriptionCancelled(token, tenantId, cancelled));
      onChanged();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  // Start-/einddatum en losse opzegging per module ("optie") — zie
  // db/migrations/0036_tenant_module_dates.sql.
  async function changeModuleStartDate(moduleKey: string, startDate: string) {
    setBusy(true);
    setError(null);
    try {
      setLicense(await api.setTenantModuleStartDate(token, tenantId, moduleKey, startDate));
      onChanged();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function changeModuleEndDate(moduleKey: string, endDate: string | null) {
    setBusy(true);
    setError(null);
    try {
      setLicense(await api.setTenantModuleEndDate(token, tenantId, moduleKey, endDate));
      onChanged();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleModuleCancelled(moduleKey: string, cancelled: boolean) {
    setBusy(true);
    setError(null);
    try {
      setLicense(await api.setTenantModuleCancelled(token, tenantId, moduleKey, cancelled));
      onChanged();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  if (!license || !tiers || !modules) {
    return error ? <p style={styles.error}>{error}</p> : <p style={styles.muted}>Laden…</p>;
  }

  const moduleAssignmentByKey = new Map(license.moduleAssignments.map((a) => [a.key, a]));
  // 'proef'/'afgewezen' sluiten altijd al onvoorwaardelijk op de einddatum
  // (zie license.ts closesUnconditionallyOnEndDate) — de opzeg-knop hieronder
  // heeft dan geen effect, dus tonen we 'm niet.
  const cancellationApplies = license.subscriptionRequestStatus !== 'proef' && license.subscriptionRequestStatus !== 'afgewezen';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {error && <p style={styles.error}>{error}</p>}
      <label style={styles.label}>
        Tier
        <select style={styles.input} disabled={busy} value={license.tier?.id ?? ''} onChange={(e) => changeTier(e.target.value ? Number(e.target.value) : null)}>
          <option value="">— geen licentie —</option>
          {tiers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <label style={styles.label}>
        Einddatum
        <input style={styles.input} type="date" disabled={busy} value={license.endDate ?? ''} onChange={(e) => changeEndDate(e.target.value || null)} />
      </label>
      {cancellationApplies ? (
        <div>
          <div style={styles.roleLabel}>Opzegging</div>
          {license.cancelledAt ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <span>
                Opgezegd op {formatDateTimeNL(license.cancelledAt)}
                {license.endDate && ` — loopt af op ${formatDateNL(license.endDate)}`}
                {license.expired && ' (nu alleen-lezen)'}.
              </span>
              <button style={btnStyle('ghost')} disabled={busy} onClick={() => toggleCancelled(false)}>Opzegging intrekken</button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <span style={styles.muted}>
                Loopt door (niet opgezegd){license.datePassed && ' — einddatum is al gepasseerd, blijft schrijfbaar tot opzegging'}.
              </span>
              <button style={btnStyle('danger')} disabled={busy} onClick={() => toggleCancelled(true)}>Opzeggen</button>
            </div>
          )}
        </div>
      ) : (
        <p style={styles.hint}>
          {license.subscriptionRequestStatus === 'proef' ? 'Proefperiode' : 'Afgewezen aanvraag'} — sluit onvoorwaardelijk op de einddatum, opzegging is hier niet van toepassing.
        </p>
      )}
      {modules.length > 0 && (
        <div>
          <div style={styles.roleLabel}>Modules</div>
          <p style={styles.hint}>
            Elke module heeft een eigen start-/einddatum en kan los van het abonnement worden opgezegd — zelfde
            polis-model: opgezegd + einddatum gepasseerd = inactief, anders blijft de module gewoon lopen.
          </p>
          {modules.map((m) => {
            const assignment = moduleAssignmentByKey.get(m.key);
            return (
              <div key={m.key} style={{ marginBottom: 10 }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={!!assignment}
                    onChange={(e) => toggleModule(m.key, e.target.checked)}
                  />
                  {m.name}
                  {assignment && (
                    <span
                      style={{
                        ...styles.healthBadge,
                        fontSize: 10,
                        padding: '1px 7px',
                        color: assignment.active ? '#1e6b34' : '#7A1F1F',
                        background: assignment.active ? '#e6f4ea' : '#FBE8E8',
                      }}
                    >
                      {assignment.active ? 'actief' : 'inactief'}
                    </span>
                  )}
                </label>
                {assignment && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginLeft: 24, marginTop: 4, fontSize: 12.5 }}>
                    <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      Start
                      <input
                        style={{ ...styles.input, padding: '3px 6px', fontSize: 12.5, width: 140 }}
                        type="date"
                        disabled={busy}
                        value={assignment.startDate}
                        onChange={(e) => e.target.value && changeModuleStartDate(m.key, e.target.value)}
                      />
                    </label>
                    <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      Einde
                      <input
                        style={{ ...styles.input, padding: '3px 6px', fontSize: 12.5, width: 140 }}
                        type="date"
                        disabled={busy}
                        value={assignment.endDate ?? ''}
                        onChange={(e) => changeModuleEndDate(m.key, e.target.value || null)}
                      />
                    </label>
                    {assignment.cancelledAt ? (
                      <>
                        <span style={styles.muted}>Opgezegd op {formatDateTimeNL(assignment.cancelledAt)}</span>
                        <button type="button" style={btnStyle('ghost')} disabled={busy} onClick={() => toggleModuleCancelled(m.key, false)}>
                          Opzegging intrekken
                        </button>
                      </>
                    ) : (
                      <button type="button" style={btnStyle('danger')} disabled={busy} onClick={() => toggleModuleCancelled(m.key, true)}>
                        Opzeggen
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p style={styles.muted}>
        Gebruik: {license.usage.activeAdmins}/{license.tier?.maxAdmins ?? '∞'} admins, {license.usage.activeBomen}/{license.tier?.maxBomen ?? '∞'} bomen.
      </p>
    </div>
  );
}

// --- Abonnement-wijzigingslog (audit_log, tenant_subscription_changed) ---

function SubscriptionHistory({ token, tenantId }: { token: string; tenantId: number }) {
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedEntryId, setExpandedEntryId] = useState<number | null>(null);

  useEffect(() => {
    api.auditLogFiltered(token, { tenantId, eventType: 'tenant_subscription_changed' })
      .then(setEntries)
      .catch((err) => setError(errMsg(err)));
  }, [token, tenantId]);

  if (error) return <p style={styles.error}>{error}</p>;
  if (!entries) return <p style={styles.muted}>Laden…</p>;
  if (entries.length === 0) return <p style={styles.muted}>Nog geen wijzigingen gelogd.</p>;

  return (
    <div style={styles.historyBox}>
      {entries.map((e) => {
        const isOpen = expandedEntryId === e.id;
        const changes = (e.detail.changes as Record<string, unknown>) ?? {};
        return (
          <div key={e.id} style={styles.historyRow}>
            <div
              style={{ ...styles.historyMeta, cursor: 'pointer' }}
              onClick={() => setExpandedEntryId(isOpen ? null : e.id)}
            >
              {formatDateTimeNL(e.createdAt)} — {e.userEmail ?? '(onbekend)'} {isOpen ? '▲' : '▼'}
            </div>
            {isOpen && (
              <ul style={styles.reasonsList}>
                {Object.entries(changes).map(([field, value]) => (
                  <li key={field}>
                    <strong>{fieldLabel(field)}</strong>:{' '}
                    {field === 'module'
                      ? describeModuleChange(value)
                      : `${formatChangeValue((value as { from: unknown }).from)} → ${formatChangeValue((value as { to: unknown }).to)}`}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function fieldLabel(field: string): string {
  if (field === 'tier_id') return 'Tier';
  if (field === 'license_end_date') return 'Einddatum';
  if (field === 'module') return 'Module';
  if (field === 'subscription_cancelled_at') return 'Opzegging';
  return field;
}

function formatChangeValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const MODULE_CHANGE_FIELD_LABEL: Record<string, string> = {
  startDate: 'Startdatum',
  endDate: 'Einddatum',
  cancelledAt: 'Opzegging',
};

// changes.module heeft NIET de generieke {from,to}-vorm (zie
// license.ts setTenantModuleActive/setTenantModuleStartDate/EndDate/
// Cancelled) — dit geeft 'm een leesbare weergave i.p.v. de generieke
// renderer die op deze vorm undefined/undefined zou tonen.
function describeModuleChange(value: unknown): string {
  if (typeof value !== 'object' || value === null) return formatChangeValue(value);
  const m = value as { key?: string; active?: boolean; field?: string; from?: unknown; to?: unknown };
  if (m.field) {
    const label = MODULE_CHANGE_FIELD_LABEL[m.field] ?? m.field;
    return `${m.key} — ${label}: ${formatChangeValue(m.from)} → ${formatChangeValue(m.to)}`;
  }
  if ('active' in m) return `${m.key}: ${m.active ? 'aangezet' : 'uitgezet'}`;
  return formatChangeValue(value);
}

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Er ging iets mis.';
}

function formatDateNL(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return dateStr;
  const [, y, mo, d] = m;
  return `${d}-${mo}-${y}`;
}

function formatDateTimeNL(isoStr: string): string {
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return isoStr;
  return d.toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function btnStyle(kind: 'primary' | 'ghost' | 'danger'): React.CSSProperties {
  if (kind === 'primary') {
    return { padding: '6px 12px', borderRadius: 6, border: 'none', background: '#2F5597', color: 'white', fontSize: 13, cursor: 'pointer' };
  }
  if (kind === 'danger') {
    return { padding: '6px 12px', borderRadius: 6, border: '1px solid #f3c2c6', background: '#FBE9EA', color: '#DC3545', fontSize: 13, cursor: 'pointer' };
  }
  return { padding: '6px 12px', borderRadius: 6, border: '1px solid #d7ddf0', background: 'white', color: '#2F5597', fontSize: 13, cursor: 'pointer' };
}

const styles: Record<string, React.CSSProperties> = {
  main: { fontFamily: 'system-ui, sans-serif', padding: 'clamp(1.25rem, 4vw, 2.5rem)', maxWidth: 1300, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: '1.5rem' },
  title: { margin: 0, color: '#203864', fontSize: 26 },
  subtitle: { margin: '4px 0 0', color: '#6c6f76', fontSize: 13.5 },
  muted: { color: '#9aa0a8', fontSize: 13 },
  hint: { color: '#6c6f76', fontSize: 12, margin: '0 0 6px' },
  error: {
    color: '#DC3545', fontSize: 13.5, background: '#FBE9EA', border: '1px solid #f3c2c6',
    borderRadius: 6, padding: '0.5rem 0.75rem', marginBottom: 12,
  },
  section: { background: 'white', borderRadius: 10, padding: '1.25rem 1.5rem', border: '1px solid #e4e6ea' },
  search: {
    width: '100%', maxWidth: 420, padding: '7px 10px', borderRadius: 6, border: '1px solid #d0d4da',
    fontSize: 13, boxSizing: 'border-box', marginBottom: 14,
  },
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13.5 },
  th: {
    textAlign: 'left', borderBottom: '1px solid #e4e6ea', padding: '6px 8px', color: '#6c6f76',
    fontWeight: 600, whiteSpace: 'nowrap',
  },
  rowClickable: { cursor: 'pointer' },
  td: { borderBottom: '1px solid #f0f1f3', padding: '6px 8px', verticalAlign: 'top' },
  tenantSlug: { fontSize: 11.5, color: '#9aa0a8' },
  chevron: { color: '#2F5597', fontSize: 12 },
  terminatedBadge: {
    display: 'inline-block', marginLeft: 6, fontSize: 10.5, padding: '1px 6px', borderRadius: 10,
    background: '#FBE8E8', color: '#7A1F1F',
  },
  primaryBadge: {
    display: 'inline-block', marginLeft: 6, fontSize: 10, padding: '1px 6px', borderRadius: 10,
    background: '#E7F0FE', color: '#2F5597', fontWeight: 600,
  },
  healthBadge: { display: 'inline-block', padding: '2px 9px', borderRadius: 10, fontSize: 12, fontWeight: 600 },
  detailCell: { background: '#f7f8fa', padding: '1rem 1.25rem', borderBottom: '1px solid #e4e6ea' },
  detailGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.25rem' },
  detailColumn: { background: 'white', borderRadius: 8, border: '1px solid #e4e6ea', padding: '0.9rem 1rem' },
  detailHeaderRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 6 },
  h3: { fontSize: 14.5, color: '#203864', margin: 0 },
  roleLabel: { fontSize: 11.5, fontWeight: 700, color: '#6c6f76', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 4 },
  contactRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8,
    padding: '6px 8px', borderRadius: 6, background: '#f7f8fa', marginBottom: 4, fontSize: 13,
  },
  historyBox: { marginTop: 10, borderTop: '1px solid #e4e6ea', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 },
  historyRow: { fontSize: 12.5 },
  historyMeta: { color: '#6c6f76' },
  historyDetail: { color: '#203864' },
  reasonsList: { margin: '4px 0 0', paddingLeft: 18, fontSize: 12.5, color: '#4a4d54' },
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(20,30,60,0.35)', display: 'flex',
    alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '1rem',
  },
  modal: {
    background: 'white', borderRadius: 10, padding: '1.25rem', width: '100%', maxWidth: 420,
    boxSizing: 'border-box', maxHeight: '90vh', overflowY: 'auto',
  },
  h2: { fontSize: 16, color: '#203864', margin: '0 0 12px' },
  label: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#203864', marginBottom: 10, fontWeight: 600 },
  input: { padding: '7px 10px', borderRadius: 6, border: '1px solid #d0d4da', fontSize: 13.5, fontWeight: 400, boxSizing: 'border-box', width: '100%' },
};

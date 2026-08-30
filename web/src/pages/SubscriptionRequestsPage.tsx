import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { LicenseEvent, SubscriptionRequest } from '../types';

// Sysadmin-only beheerscherm voor abonnementsaanvragen/-verlengingen — zie
// doelenboom_licentiemodel.md §9. Bereikbaar via de meldingsbanner bovenin
// (zie App.tsx/PickerPage.tsx) of los. Elke actie hieronder wordt door de
// server gelogd in license_events (aparte logging-module, zie
// api/src/subscriptions.ts) — die geschiedenis is per aanvraag in te zien via
// "Geschiedenis" hieronder.
export default function SubscriptionRequestsPage({ token, onBack }: { token: string; onBack: () => void }) {
  const [requests, setRequests] = useState<SubscriptionRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyFor, setHistoryFor] = useState<SubscriptionRequest | null>(null);

  function load() {
    api.subscriptionRequests(token).then(setRequests).catch((err) => setError(errMsg(err)));
  }
  useEffect(load, [token]);

  const today = new Date().toISOString().slice(0, 10);
  const in30Days = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const proef = (requests ?? []).filter((r) => r.status === 'proef');
  const nearingRenewal = (requests ?? []).filter(
    (r) => r.status === 'actief' && r.contractEndDate != null && r.contractEndDate <= in30Days
  );
  const rest = (requests ?? []).filter((r) => !proef.includes(r) && !nearingRenewal.includes(r));

  async function registerPayment(r: SubscriptionRequest) {
    setBusy(true);
    setError(null);
    try {
      await api.registerSubscriptionPayment(token, r.id);
      load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function registerRenewal(r: SubscriptionRequest) {
    setBusy(true);
    setError(null);
    try {
      await api.registerSubscriptionRenewal(token, r.id);
      load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function reject(r: SubscriptionRequest) {
    const reason = window.prompt(`Aanvraag van "${r.organizationName}" afwijzen — reden (verplicht):`);
    if (reason == null) return; // geannuleerd
    if (!reason.trim()) {
      setError('Reden is verplicht bij afwijzen.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.rejectSubscriptionRequest(token, r.id, reason.trim());
      load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Aanvragen</h1>
          <p style={styles.subtitle}>Abonnementsaanvragen en naderende verlengingen afhandelen.</p>
        </div>
        <button onClick={onBack} style={btnStyle('ghost')}>← Terug</button>
      </header>

      {error && <p style={styles.error}>{error}</p>}
      {!requests && <p style={styles.muted}>Laden…</p>}

      {requests && (
        <>
          <Section title={`Te behandelen — nog op proef (${proef.length})`}>
            {proef.length === 0 && <p style={styles.muted}>Geen openstaande aanvragen.</p>}
            {proef.map((r) => {
              const daysLeft = r.licenseEndDate ? Math.ceil((new Date(r.licenseEndDate).getTime() - Date.now()) / 86400000) : null;
              return (
                <Row key={r.id}>
                  <RowInfo r={r} extra={daysLeft != null ? `proef eindigt over ${daysLeft} dag${daysLeft === 1 ? '' : 'en'} (${r.licenseEndDate})` : undefined} />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button disabled={busy} onClick={() => registerPayment(r)} style={btnStyle('primary')}>Betaling registreren</button>
                    <button disabled={busy} onClick={() => reject(r)} style={btnStyle('danger-text')}>Afwijzen</button>
                    <button disabled={busy} onClick={() => setHistoryFor(r)} style={btnStyle('ghost')}>Geschiedenis</button>
                  </div>
                </Row>
              );
            })}
          </Section>

          <Section title={`Vervalt binnen 30 dagen (${nearingRenewal.length})`}>
            {nearingRenewal.length === 0 && <p style={styles.muted}>Geen naderende verlengingen.</p>}
            {nearingRenewal.map((r) => (
              <Row key={r.id}>
                <RowInfo r={r} extra={`contract eindigt ${r.contractEndDate} (alleen-lezen vanaf ${r.licenseEndDate} als niet verlengd)`} />
                <div style={{ display: 'flex', gap: 6 }}>
                  <button disabled={busy} onClick={() => registerRenewal(r)} style={btnStyle('primary')}>Verlenging registreren</button>
                  <button disabled={busy} onClick={() => setHistoryFor(r)} style={btnStyle('ghost')}>Geschiedenis</button>
                </div>
              </Row>
            ))}
          </Section>

          <Section title={`Overige (${rest.length})`}>
            {rest.length === 0 && <p style={styles.muted}>Geen overige aanvragen.</p>}
            {rest.map((r) => (
              <Row key={r.id}>
                <RowInfo r={r} extra={r.status === 'actief' ? `contract eindigt ${r.contractEndDate}` : r.status === 'afgewezen' ? `afgewezen: ${r.rejectedReason}` : undefined} />
                <div style={{ display: 'flex', gap: 6 }}>
                  {r.status === 'actief' && (
                    <button disabled={busy} onClick={() => registerRenewal(r)} style={btnStyle('ghost')}>Vast verlengen</button>
                  )}
                  <button disabled={busy} onClick={() => setHistoryFor(r)} style={btnStyle('ghost')}>Geschiedenis</button>
                </div>
              </Row>
            ))}
          </Section>
        </>
      )}

      {historyFor && <HistoryModal token={token} request={historyFor} onClose={() => setHistoryFor(null)} />}
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={styles.section}>
      <h2 style={styles.h2}>{title}</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={styles.row}>{children}</div>;
}

function RowInfo({ r, extra }: { r: SubscriptionRequest; extra?: string }) {
  return (
    <div>
      <strong>{r.organizationName}</strong>{' '}
      <span style={{ opacity: 0.7, fontSize: 12.5 }}>
        — {r.tierName ?? 'onbekende tier'}, {r.applicantName} ({r.applicantEmail}
        {r.applicantPhone && <>, {r.applicantPhone}</>})
        {r.priceAtRequest && <> · € {Number(r.priceAtRequest).toLocaleString('nl-NL')}</>}
      </span>
      {extra && <div style={{ fontSize: 11.5, color: '#946200', marginTop: 2 }}>{extra}</div>}
    </div>
  );
}

function HistoryModal({ token, request, onClose }: { token: string; request: SubscriptionRequest; onClose: () => void }) {
  const [events, setEvents] = useState<LicenseEvent[] | null>(null);
  useEffect(() => {
    api.subscriptionRequestEvents(token, request.id).then(setEvents).catch(() => setEvents([]));
  }, [token, request.id]);

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2 style={styles.h2}>Geschiedenis — {request.organizationName}</h2>
        {!events && <p style={styles.muted}>Laden…</p>}
        {events && events.length === 0 && <p style={styles.muted}>Nog geen gebeurtenissen.</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflowY: 'auto' }}>
          {events?.map((e) => (
            <div key={e.id} style={styles.eventRow}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{e.eventType}</div>
              <div style={{ fontSize: 11.5, opacity: 0.7 }}>
                {new Date(e.createdAt).toLocaleString('nl-NL')} — {e.performedByEmail ?? 'aanvrager (publiek)'}
              </div>
              <pre style={styles.eventDetail}>{JSON.stringify(e.detail, null, 2)}</pre>
            </div>
          ))}
        </div>
        <button onClick={onClose} style={{ ...btnStyle('ghost'), marginTop: 12 }}>Sluiten</button>
      </div>
    </div>
  );
}

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Er ging iets mis.';
}

function btnStyle(kind: 'primary' | 'ghost' | 'danger-text'): React.CSSProperties {
  if (kind === 'primary') {
    return { padding: '6px 12px', borderRadius: 6, border: 'none', background: '#2F5597', color: 'white', fontSize: 13, cursor: 'pointer' };
  }
  if (kind === 'danger-text') {
    return { padding: '6px 12px', borderRadius: 6, border: '1px solid #f3c2c6', background: 'white', color: '#DC3545', fontSize: 13, cursor: 'pointer' };
  }
  return { padding: '6px 12px', borderRadius: 6, border: '1px solid #d7ddf0', background: 'white', color: '#2F5597', fontSize: 13, cursor: 'pointer' };
}

const styles: Record<string, React.CSSProperties> = {
  main: { fontFamily: 'system-ui, sans-serif', padding: 'clamp(1.25rem, 4vw, 2.5rem)', maxWidth: 900, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' },
  title: { margin: 0, color: '#203864', fontSize: 26 },
  subtitle: { margin: '4px 0 0', color: '#6c6f76', fontSize: 13.5 },
  muted: { color: '#9aa0a8', fontSize: 13.5 },
  error: { color: '#DC3545', fontSize: 13.5, background: '#FBE9EA', border: '1px solid #f3c2c6', borderRadius: 6, padding: '0.5rem 0.75rem', marginBottom: 12 },
  section: { marginBottom: '1.75rem' },
  h2: { fontSize: 15, color: '#203864', margin: '0 0 10px' },
  row: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    border: '1px solid #e4e6ea', borderRadius: 8, padding: '0.6rem 0.85rem', fontSize: 13.5,
  },
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(20,30,60,0.35)', display: 'flex',
    alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '1rem',
  },
  modal: { background: 'white', borderRadius: 10, padding: '1.25rem', width: '100%', maxWidth: 520, boxSizing: 'border-box' },
  eventRow: { border: '1px solid #eee', borderRadius: 6, padding: '0.5rem 0.65rem' },
  eventDetail: { fontSize: 11, background: '#f7f7f9', borderRadius: 4, padding: '0.4rem', margin: '4px 0 0', overflowX: 'auto' },
};

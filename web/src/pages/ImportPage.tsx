import { ChangeEvent, useState } from 'react';
import { api, ApiError } from '../api';
import type { DoelenboomSummary, ImportDetail } from '../types';

export default function ImportPage({
  token,
  doelenboom,
  onBack,
}: {
  token: string;
  doelenboom: DoelenboomSummary;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const [published, setPublished] = useState<{ elementCount: number; edgeCount: number } | null>(null);

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setDetail(null);
    setPublished(null);
    setBusy(true);
    try {
      const summary = await api.uploadImport(token, doelenboom.id, file);
      const full = await api.importDetail(token, summary.id);
      setDetail(full);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload mislukt');
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  }

  async function handlePublish() {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.publishImport(token, detail.id);
      setPublished(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Publiceren mislukt');
    } finally {
      setBusy(false);
    }
  }

  const report = detail?.report_json;
  const canPublish = detail && detail.status !== 'failed' && !published;

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 720, margin: '0 auto' }}>
      <button onClick={onBack} style={{ border: 'none', background: 'none', color: '#2F5597', cursor: 'pointer', marginBottom: 12 }}>
        ← Terug naar {doelenboom.name}
      </button>
      <h1 style={{ color: '#203864', marginTop: 0 }}>Excel importeren</h1>
      <p style={{ color: '#6c6f76', fontSize: 14 }}>
        Upload een <code>FPBB_doelenboom_referentietabel_*.xlsx</code>-bestand. De inhoud wordt eerst geparsed en
        gevalideerd — pas na een expliciete bevestiging vervangt dit de huidige inhoud van deze doelenboom.
      </p>

      <input type="file" accept=".xlsx" onChange={handleFile} disabled={busy} />

      {error && <p style={{ color: '#DC3545' }}>{error}</p>}
      {busy && <p>Bezig…</p>}

      {report && (
        <section style={{ marginTop: '1.5rem' }}>
          <h2 style={{ fontSize: 16 }}>Rapport — {report.filename}</h2>
          <p style={{ fontSize: 13 }}>
            Status: <strong>{detail!.status}</strong>
            {report.format && (
              <>
                {' '}— formaat: <strong>{report.format === 'nieuw' ? 'Nieuw' : 'Oud'}</strong>
              </>
            )}
          </p>

          {report.sheetsMissing.length > 0 && (
            <p style={{ fontSize: 13, color: '#D9822B' }}>
              Ontbrekende tabbladen: {report.sheetsMissing.join(', ')}
            </p>
          )}

          <table style={{ fontSize: 13, borderCollapse: 'collapse', marginBottom: '1rem' }}>
            <tbody>
              {Object.entries(report.counts).map(([k, v]) => (
                <tr key={k}>
                  <td style={{ padding: '2px 12px 2px 0', color: '#6c6f76' }}>{k}</td>
                  <td style={{ padding: '2px 0', fontWeight: 600 }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {report.errors.length > 0 && (
            <div style={{ marginBottom: '1rem' }}>
              <h3 style={{ fontSize: 13, color: '#DC3545' }}>Fouten</h3>
              <ul style={{ fontSize: 12, color: '#DC3545' }}>
                {report.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          {report.warnings.length > 0 && (
            <div style={{ marginBottom: '1rem' }}>
              <h3 style={{ fontSize: 13, color: '#D9822B' }}>Waarschuwingen ({report.warnings.length})</h3>
              <ul style={{ fontSize: 12, maxHeight: 220, overflowY: 'auto' }}>
                {report.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {published ? (
            <>
              <p style={{ color: '#2E7D5B', fontWeight: 600 }}>
                Gepubliceerd: {published.elementCount} elementen, {published.edgeCount} relaties.
              </p>
              <button
                onClick={onBack}
                style={{
                  border: 'none',
                  background: '#2F5597',
                  color: 'white',
                  padding: '0.6rem 1.4rem',
                  borderRadius: 6,
                  fontSize: 14,
                  cursor: 'pointer',
                }}
              >
                OK — terug naar de boom
              </button>
            </>
          ) : (
            canPublish && (
              <button
                onClick={handlePublish}
                disabled={busy}
                style={{
                  border: 'none',
                  background: '#2E7D5B',
                  color: 'white',
                  padding: '0.6rem 1.2rem',
                  borderRadius: 6,
                  fontSize: 14,
                  cursor: 'pointer',
                }}
              >
                Doorvoeren
              </button>
            )
          )}
        </section>
      )}
    </main>
  );
}

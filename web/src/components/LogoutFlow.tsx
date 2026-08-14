import { useEffect, useState } from 'react';
import { api, API_URL, ApiError } from '../api';
import type { WipeCandidate } from '../types';

// Uitloggen is een flow van meerdere stappen i.p.v. één klik, omdat het soms een
// onomkeerbaar bijeffect heeft: als dit de laatste actieve gebruiker van een
// tenant is (zie api/src/tenantWipe.ts), wordt de inhoud van die tenant geleegd.
// Volgorde: 1) preview ophalen (geen bijeffecten), 2) zo nodig eerst een
// Excel-export aanbieden per doelenboom die geleegd gaat worden, 3) een aparte,
// expliciete waarschuwing tonen, 4) pas dan het echte /logout-verzoek.
//
// Los van PickerPage.tsx gemaakt (i.p.v. daarin) zodat "Uitloggen" ook vanuit de
// boomweergave (tree.html, via postMessage) dezelfde flow kan starten — App.tsx
// rendert dit als overlay boven de huidige pagina, ongeacht welke dat is.
type Step = 'checking' | 'export-offer' | 'confirm' | 'busy' | 'error';

async function downloadDoelenboomExcel(token: string, doelenboomId: number, nameHint: string) {
  const res = await fetch(`${API_URL}/api/doelenbomen/${doelenboomId}/export?format=oud&mode=data`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Export mislukt (HTTP ' + res.status + ')');
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match ? match[1] : `${nameHint}.xlsx`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export default function LogoutFlow({
  token,
  onDone,
  onCancel,
}: {
  token: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<Step>('checking');
  const [wipeCandidates, setWipeCandidates] = useState<WipeCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .logoutPreview(token)
      .then(({ wouldWipe }) => {
        if (cancelled) return;
        if (wouldWipe.length === 0) {
          finalize();
        } else {
          setWipeCandidates(wouldWipe);
          // Alleen om een export vragen als er ook echt iets te exporteren valt
          // (elementCount > 0 ergens) -- anders direct door naar de bevestiging
          // met een simpele melding, zie de 'confirm'-stap hieronder.
          const hasContent = wouldWipe.some((c) => c.doelenbomen.some((d) => d.elementCount > 0));
          setStep(hasContent ? 'export-offer' : 'confirm');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Kon niet controleren of uitloggen data verwijdert.');
        setStep('error');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function finalize() {
    setStep('busy');
    try {
      await api.logout(token);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Uitloggen mislukt.');
      setStep('confirm');
    }
  }

  const allDoelenbomen = wipeCandidates.flatMap((c) =>
    c.doelenbomen.map((d) => ({ ...d, tenantName: c.tenant.name }))
  );
  // Voor de exportvraag alleen doelenbomen tonen die ook echt iets bevatten --
  // een exportknop aanbieden voor iets leegs heeft geen zin.
  const exportableDoelenbomen = allDoelenbomen.filter((d) => d.elementCount > 0);
  const hasAnyContent = exportableDoelenbomen.length > 0;

  if (step === 'checking') return null; // heel kort, geen flits van een lege modal nodig

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
    >
      <div style={{ background: 'white', borderRadius: 12, padding: '1.75rem 2rem', maxWidth: 460, width: '90vw', boxShadow: '0 8px 24px rgba(0,0,0,0.3)', fontFamily: 'system-ui, sans-serif' }}>
        {step === 'error' && (
          <>
            <h3 style={{ margin: '0 0 10px', color: '#DC3545' }}>Uitloggen mislukt</h3>
            <p style={{ fontSize: 13.5, color: '#444', lineHeight: 1.5, margin: '0 0 16px' }}>{error}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={onCancel} style={btnStyle('ghost')}>Sluiten</button>
            </div>
          </>
        )}

        {step === 'export-offer' && (
          <>
            <h3 style={{ margin: '0 0 10px', color: '#203864' }}>Data exporteren voordat je uitlogt?</h3>
            <p style={{ fontSize: 13.5, color: '#444', lineHeight: 1.5, margin: '0 0 14px' }}>
              Je bent de laatste actieve gebruiker van de volgende doelenboom(en). Bij het uitloggen wordt hun
              data automatisch geleegd. Wil je eerst een Excel-export downloaden?
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
              {exportableDoelenbomen.map((d) => (
                <div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: '#f7f8fa', borderRadius: 8, padding: '8px 12px' }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#222' }}>{d.name}</div>
                    <div style={{ fontSize: 11.5, color: '#888' }}>{d.tenantName}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => downloadDoelenboomExcel(token, d.id, d.slug).catch((err) => setError(err.message))}
                    style={{ border: '1.5px solid #2F5597', background: 'white', color: '#2F5597', borderRadius: 999, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                  >
                    ↥ Excel downloaden
                  </button>
                </div>
              ))}
            </div>
            {error && <p style={{ color: '#DC3545', fontSize: 12.5 }}>{error}</p>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={onCancel} style={btnStyle('ghost')}>Annuleren</button>
              <button onClick={() => setStep('confirm')} style={btnStyle('primary')}>Verdergaan</button>
            </div>
          </>
        )}

        {(step === 'confirm' || step === 'busy') && (
          <>
            {hasAnyContent ? (
              <>
                <h3 style={{ margin: '0 0 10px', color: '#DC3545' }}>Let op: data wordt verwijderd</h3>
                <p style={{ fontSize: 13.5, color: '#444', lineHeight: 1.5, margin: '0 0 16px' }}>
                  Als je nu uitlogt, wordt de data van{' '}
                  <strong>{allDoelenbomen.map((d) => d.name).join(', ')}</strong> definitief uit de applicatie
                  verwijderd. Dit kan niet ongedaan worden gemaakt.
                </p>
              </>
            ) : (
              <>
                <h3 style={{ margin: '0 0 10px', color: '#203864' }}>Niets gewijzigd — data wordt verwijderd</h3>
                <p style={{ fontSize: 13.5, color: '#444', lineHeight: 1.5, margin: '0 0 16px' }}>
                  <strong>{allDoelenbomen.map((d) => d.name).join(', ')}</strong> {allDoelenbomen.length === 1 ? 'is' : 'zijn'} al leeg,
                  er gaat dus niets verloren.
                </p>
              </>
            )}
            {error && <p style={{ color: '#DC3545', fontSize: 12.5 }}>{error}</p>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={onCancel} disabled={step === 'busy'} style={btnStyle('ghost')}>Annuleren</button>
              <button onClick={finalize} disabled={step === 'busy'} style={btnStyle(hasAnyContent ? 'danger' : 'primary')}>
                {step === 'busy' ? 'Bezig…' : hasAnyContent ? 'Ja, uitloggen en verwijderen' : 'Uitloggen'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function btnStyle(kind: 'ghost' | 'primary' | 'danger'): React.CSSProperties {
  const base: React.CSSProperties = {
    borderRadius: 999, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  };
  if (kind === 'ghost') return { ...base, border: '1.5px solid #bbb', background: 'white', color: '#777' };
  if (kind === 'danger') return { ...base, border: '1.5px solid #DC3545', background: '#DC3545', color: 'white' };
  return { ...base, border: '1.5px solid #2F5597', background: '#2F5597', color: 'white' };
}

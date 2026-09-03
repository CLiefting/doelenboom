// Popup-melding, per tenant instelbaar (zie TenantSettingsForm in
// TenantManagementPage.tsx), die verschijnt zodra iemand een doelenboom uit
// die tenant selecteert — vóórdat de boom daadwerkelijk geopend wordt. "OK"
// gaat door, "Annuleren" laat de gebruiker gewoon op de boom-kiezer staan.
// Zelfde "position:fixed;inset:0" overlay-idioom als LogoutFlow.tsx, maar
// zonder de meerdere stappen die uitloggen wel heeft — hier is één simpele
// bevestiging genoeg.
//
// Gemount vanuit App.tsx (niet vanuit PickerPage.tsx), zodat de gate op één
// centrale plek zit: App.tsx's onSelect is het enige punt waar een
// geselecteerde doelenboom ook echt "geopend" wordt (zie App.tsx).
export default function TenantEntryNotice({
  message,
  onConfirm,
  onCancel,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
    >
      <div style={{ background: 'white', borderRadius: 12, padding: '1.75rem 2rem', maxWidth: 460, width: '90vw', boxShadow: '0 8px 24px rgba(0,0,0,0.3)', fontFamily: 'system-ui, sans-serif' }}>
        <h3 style={{ margin: '0 0 10px', color: '#203864' }}>Let op</h3>
        <p style={{ fontSize: 13.5, color: '#444', lineHeight: 1.5, margin: '0 0 16px', whiteSpace: 'pre-wrap' }}>
          {message}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onCancel} style={btnStyle('ghost')}>Annuleren</button>
          <button onClick={onConfirm} style={btnStyle('primary')}>OK</button>
        </div>
      </div>
    </div>
  );
}

function btnStyle(kind: 'ghost' | 'primary'): React.CSSProperties {
  const base: React.CSSProperties = {
    borderRadius: 999, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  };
  if (kind === 'ghost') return { ...base, border: '1.5px solid #bbb', background: 'white', color: '#777' };
  return { ...base, border: '1.5px solid #2F5597', background: '#2F5597', color: 'white' };
}

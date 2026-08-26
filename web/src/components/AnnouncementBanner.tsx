import { useEffect, useState } from 'react';
import { api } from '../api';

// Systeembrede mededeling (bv. onderhoudsaankondiging) — zie
// api/src/routes/announcement.ts. Ongeauthenticeerd op te halen, dus zichtbaar
// op zowel het inlogscherm als in de app zelf (zie App.tsx: gerenderd op alle
// drie de return-paden). Ververst elke minuut, zodat een net door een sysadmin
// aangezette (of uitgezette) mededeling zonder herladen zichtbaar/onzichtbaar
// wordt.
const POLL_INTERVAL_MS = 60_000;
const DISMISSED_KEY = 'doelenboom.announcementDismissed';

export default function AnnouncementBanner() {
  const [announcement, setAnnouncement] = useState<{ message: string; active: boolean } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    function load() {
      api.announcement().then((a) => {
        if (cancelled) return;
        setAnnouncement(a);
        // Per-tab dismiss is gekoppeld aan de tekst zelf: zet een sysadmin een
        // ándere mededeling aan (of dezelfde na een eerdere keer uit/aan), dan
        // moet die weer getoond worden — niet stilzwijgend weggeblazen door
        // een oude dismiss van een vórige mededeling.
        setDismissed(sessionStorage.getItem(DISMISSED_KEY) === a.message);
      }).catch(() => {});
    }
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!announcement || !announcement.active || !announcement.message || dismissed) return null;

  function handleDismiss() {
    sessionStorage.setItem(DISMISSED_KEY, announcement!.message);
    setDismissed(true);
  }

  return (
    <div style={styles.banner} role="alert">
      <span style={styles.text}>{announcement.message}</span>
      <button onClick={handleDismiss} style={styles.closeBtn} aria-label="Melding sluiten">✕</button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // Bewust GEEN position:fixed (dat was de eerdere opzet): dit component werd
  // dan over de rest van de pagina heen getekend, inclusief de topbar van
  // tree.html (dat zelf een full-screen <iframe> is, zie TreePage.tsx) — met
  // als gevolg dat de banner de "Terug"/"Filters"/"Uitloggen"/"Help"-knoppen
  // erin verborg en onklikbaar maakte. Nu gewoon een normaal blok bovenaan de
  // flex-kolom in App.tsx: dat duwt al het andere (inclusief de iframe, die
  // zijn hoogte via 100% van zijn flex:1-container krijgt i.p.v. een vaste
  // 100vh) simpelweg naar beneden, in plaats van eroverheen te liggen.
  // position:relative blijft nodig zodat de losse sluitknop (position:absolute
  // hieronder) relatief aan déze balk blijft geankerd.
  banner: {
    position: 'relative', flexShrink: 0, width: '100%', zIndex: 10,
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16,
    background: '#FFF3CD', borderBottom: '1px solid #FFE69C', color: '#664d03',
    padding: '0.6rem 2.5rem 0.6rem 1rem', fontSize: 14, fontWeight: 600,
    fontFamily: 'system-ui, sans-serif', boxSizing: 'border-box',
    textAlign: 'center',
  },
  text: { flex: '0 1 auto' },
  closeBtn: {
    position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
    border: 'none', background: 'transparent', color: '#664d03', cursor: 'pointer',
    fontSize: 15, lineHeight: 1, padding: 4,
  },
};

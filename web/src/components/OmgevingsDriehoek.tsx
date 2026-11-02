import { useEffect, useState } from 'react';
import { api } from '../api';
import { driehoekVoor, tabTitel, type DriehoekWeergave } from '../omgeving';

// DOEL-131: gekleurde driehoek linksboven op ELKE pagina zolang je niet in
// productie werkt — groen "ONT" in ontwikkeling, geel "ACC" in acceptatie.
// Gerenderd in main.tsx rond de root, dus ook op inloggen, registreren, MFA,
// voorwaarden en de losse beheerpagina's (/dbstat, /system-info, ...).
//
// Net als VersionFooter: position:fixed met de hoogste z-index, zodat hij ook
// boven de boomweergave (een full-screen iframe met tree.html) ligt, en
// pointer-events:none, zodat alles eronder klikbaar blijft.
//
// De omgeving komt van GET /api/version (alleen buiten productie gevuld). De
// tekst wordt als gewone React-tekst gezet, nooit als HTML (OWASP A03).
// 192 px (3x de eerste versie van 64 px, op verzoek van Charles 02-11-2026: 64 px was te
// onopvallend); op smalle schermen (telefoon) 96 px, anders valt er te veel inhoud onder.
const SMAL = '(max-width: 600px)';
const isSmal = () => typeof window.matchMedia === 'function' && window.matchMedia(SMAL).matches;

export default function OmgevingsDriehoek() {
  const [weergave, setWeergave] = useState<DriehoekWeergave | null>(null);
  const [smal, setSmal] = useState<boolean>(isSmal);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(SMAL);
    const bij = () => setSmal(mq.matches);
    mq.addEventListener('change', bij);
    return () => mq.removeEventListener('change', bij);
  }, []);

  useEffect(() => {
    let actief = true;
    api
      .version()
      .then((r) => {
        if (!actief) return;
        setWeergave(driehoekVoor(r.omgeving));
        document.title = tabTitel(document.title, r.omgeving);
      })
      .catch(() => {});
    return () => {
      actief = false;
    };
  }, []);

  if (!weergave) return null;
  const maat = smal ? 96 : 192;
  // Tekst schaalt mee met de driehoek (36 px bij 192, 18 px bij 96).
  const letter = Math.round(maat * 0.19);
  // De tekst staat schuin op de lijn door het zwaartepunt van de driehoek (1/3, 1/3).
  const band = Math.round(maat * 0.7);
  return (
    <div
      role="img"
      aria-label={weergave.omschrijving}
      data-omgeving={weergave.label}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: maat,
        height: maat,
        zIndex: 2147483647,
        pointerEvents: 'none',
        userSelect: 'none',
        background: weergave.achtergrond,
        clipPath: 'polygon(0 0, 100% 0, 0 100%)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          width: band,
          left: Math.round(maat / 3 - band / 2),
          top: Math.round(maat / 3 - letter / 2),
          textAlign: 'center',
          fontSize: letter,
          color: weergave.tekstkleur,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontWeight: 700,
          letterSpacing: '0.08em',
          transform: 'rotate(-45deg)',
          lineHeight: 1,
        }}
      >
        {weergave.label}
      </span>
    </div>
  );
}

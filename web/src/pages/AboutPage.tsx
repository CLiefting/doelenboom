// Publieke uitlegpagina — "Wat is een doelenboom, en wat kan je met de app?"
// Bereikbaar zonder in te loggen, via een link op het inlogscherm
// (LoginPage.tsx: "Wat is een Doelenboom?"). Bewust een aparte pagina van
// HelpPage.tsx: HelpPage is feature-documentatie voor iemand die al toegang
// heeft en aan de slag wil ("hoe doe ik dit?"), deze pagina is een
// concept-uitleg met voorbeeldschermen voor iemand die het platform nog niet
// kent en moet worden overtuigd ("wat is dit, en waarom zou ik dit willen?").
// Geen API-calls, puur statische content + drie screenshots van de
// Demo-tenant/"Gezond ouder"-boom (zie web/public/about/).
export default function AboutPage({ onBack }: { onBack: () => void }) {
  return (
    <div style={styles.page}>
      <style>{`
        @media (max-width: 820px) {
          .about-shot-row { flex-direction: column !important; }
          .about-shot-row > * { max-width: 100% !important; }
        }
      `}</style>

      <div style={styles.heroBand}>
        <div style={styles.heroTile}>
          <div style={styles.brandRow}>
            <span style={styles.brandMark}>D</span>
            <span style={styles.brandName}>Doelenboom</span>
          </div>
          <h1 style={styles.heroHeadline}>Wat is een doelenboom?</h1>
          <p style={styles.heroSubline}>
            Eén heldere lijn van missie tot project — en precies te zien welk project waaraan bijdraagt.
          </p>
        </div>
      </div>

      <main style={styles.main}>
        <button onClick={onBack} style={styles.backBtn}>← Terug naar inloggen</button>

        <section style={styles.introSection}>
          <h2 style={styles.h2}>Het idee: van ambitie naar aantoonbare waarde</h2>
          <p style={styles.p}>
            Elke organisatie heeft een missie — en projecten die daaraan zouden moeten bijdragen. Maar tussen die
            twee zit meestal een gat: het is vaak niet hard te maken <em>waarom</em> een project ertoe doet, of
            welk deel van de strategie zonder dat project blijft liggen. Een doelenboom vult dat gat op met een
            expliciete, visuele keten: <strong>project → capability → operationele benefit → sub-benefit →
            programmabaat → strategische benefit → strategisch doel → missie</strong>. Elke stap in die keten
            is een kolom; elke kolom bestaat uit elementen (vakjes); en elk element is verbonden met de
            elementen in de kolom ernaast.
          </p>
          <p style={styles.p}>
            Het resultaat is geen los rijtje projecten en geen los strategiedocument, maar één samenhangend
            geheel waarin je in beide richtingen kunt redeneren: van missie naar de projecten die daaraan
            werken, of van een project naar het strategische doel dat het uiteindelijk dient. Welke kolommen een
            doelenboom precies heeft — hoeveel, hoe genoemd, welke kleur — is zelf instelbaar per organisatie;
            de acht hierboven zijn het standaardpatroon.
          </p>
        </section>

        <section style={styles.shotSection}>
          <div style={styles.shotText}>
            <span style={styles.stepLabel}>Voorbeeld 1</span>
            <h2 style={styles.h2}>Het overzicht: de hele keten in één oogopslag</h2>
            <p style={styles.p}>
              Dit is een echte doelenboom uit onze demo-omgeving, voor een fictief verzorgingshuis met als
              missie "Gezond ouder worden". Van links naar rechts: vier projecten, die samen vier capabilities
              opbouwen, die operationele verbeteringen opleveren, die weer bijdragen aan twee programma's
              ("Actief Blijven" en "Samen Actief"), die uiteindelijk twee strategische doelen ondersteunen.
            </p>
            <p style={styles.p}>
              De waarde hiervan zit 'm niet in de losse vakjes, maar in de <strong>lijnen ertussen</strong>: in
              één oogopslag is te zien welk project via welke capability aan welk programma bijdraagt, en welke
              programma's samen de twee strategische doelen dragen — de keten dwingt af dat elke ambitie ergens
              concreet wordt, en dat elk project ergens toe dient. Voor een presentatie aan bestuur of
              stakeholders is dit meteen het complete verhaal, zonder aparte sheets.
            </p>
          </div>
          <figure style={styles.shotFigure}>
            <img src="/about/overzicht.png" alt="Overzicht van de volledige doelenboom, alle kolommen zichtbaar" style={styles.shotImg} />
            <figcaption style={styles.shotCaption}>De volledige keten van "Gezond ouder", alle acht kolommen naast elkaar.</figcaption>
          </figure>
        </section>

        <section style={{ ...styles.shotSection, flexDirection: 'row-reverse' }} className="about-shot-row">
          <div style={styles.shotText}>
            <span style={styles.stepLabel}>Voorbeeld 2</span>
            <h2 style={styles.h2}>Eén element aanklikken: het volledige pad licht op</h2>
            <p style={styles.p}>
              Klik op een willekeurig vak, en het complete verbonden pad — van dat element helemaal tot aan de
              missie — wordt gemarkeerd. Hier is bijvoorbeeld de capability "Valrisicoscreening en -monitoring"
              geselecteerd: direct zichtbaar welk project deze capability opbouwt, welke operationele benefit
              hij oplevert, en via welke programmabaat en strategische benefit dit uiteindelijk bijdraagt aan
              het doel "Bewoners blijven langer lichamelijk vitaal".
            </p>
            <p style={styles.p}>
              Dit is precies het soort vraag dat normaal lastig te beantwoorden is: "als we hiermee stoppen, wat
              raakt dat dan?" of "waarom investeren we hier eigenlijk in?". Met een doelenboom is het antwoord
              een klik, geen speurtocht door losse documenten.
            </p>
          </div>
          <figure style={styles.shotFigure}>
            <img src="/about/element-geselecteerd.png" alt="Een capability-element geselecteerd, met het volledige pad naar de missie gemarkeerd" style={styles.shotImg} />
            <figcaption style={styles.shotCaption}>Eén klik op "Valrisicoscreening en -monitoring" markeert het hele pad tot aan de missie.</figcaption>
          </figure>
        </section>

        <section style={styles.shotSection}>
          <div style={styles.shotText}>
            <span style={styles.stepLabel}>Voorbeeld 3</span>
            <h2 style={styles.h2}>Een project in detail: niet alleen strategie, ook voortgang</h2>
            <p style={styles.p}>
              Dubbelklik op een project en de boom zoomt in op precies dat project en zijn directe context.
              Rechts verschijnt het projectpaneel: RAG-status (hier "Oranje" — actief, met een probleem),
              omschrijving, KPI en de koppeling terug naar de capability. Eronder staat de tijdlijn met
              deliverables — hier "Digitale screeningstool", 40% klaar, met een concrete voortgangsnotitie
              ("Vertraging door leverancier van de screeningstool").
            </p>
            <p style={styles.p}>
              Dat koppelt twee dingen die meestal apart leven: een projectplanning die los staat van de
              strategie, en een strategiedocument dat nooit meer wordt bijgewerkt zodra de projecten lopen. Hier
              is het één geheel — een vertraging bij een leverancier is dus niet alleen een rood vlaggetje in een
              planningstool, maar direct zichtbaar in de keten naar het strategische doel dat dit project dient.
            </p>
          </div>
          <figure style={styles.shotFigure}>
            <img src="/about/project-geselecteerd.png" alt="Een project uitgezoomd, met het projectpaneel: status, tijdlijn en deliverables" style={styles.shotImg} />
            <figcaption style={styles.shotCaption}>Dubbelklik op een project: gezoomde context links, status/tijdlijn/deliverables rechts en eronder.</figcaption>
          </figure>
        </section>

        <section style={styles.closingSection}>
          <h2 style={{ ...styles.h2, color: 'white' }}>Benieuwd hoe dit voor uw organisatie zou werken?</h2>
          <p style={{ ...styles.p, color: 'rgba(255,255,255,0.88)' }}>
            Vraag een abonnement aan en begin met uw eigen doelenboom — of log in als u al toegang heeft.
          </p>
          <button onClick={onBack} style={styles.ctaBtn}>← Terug naar inloggen</button>
        </section>
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { display: 'flex', flexDirection: 'column', minHeight: '100vh', fontFamily: 'system-ui, sans-serif', background: '#eef1f8' },
  heroBand: { display: 'flex', justifyContent: 'center', padding: 'clamp(0.75rem, 2.5vw, 1.5rem) clamp(1rem, 4vw, 2.5rem) 0' },
  heroTile: {
    width: '100%', maxWidth: 860, textAlign: 'center',
    background: 'linear-gradient(135deg, #203864 0%, #2F5597 100%)',
    borderRadius: 16, padding: 'clamp(1rem, 3vw, 1.75rem) clamp(1rem, 5vw, 3rem)',
    boxShadow: '0 12px 32px rgba(32, 56, 100, 0.25)', boxSizing: 'border-box',
  },
  brandRow: { display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center', marginBottom: 8 },
  brandMark: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 30, height: 30, borderRadius: 8, background: 'rgba(255,255,255,0.16)',
    color: 'white', fontWeight: 700, fontSize: 15,
  },
  brandName: { color: 'white', fontWeight: 700, fontSize: 16, letterSpacing: -0.3 },
  heroHeadline: { color: 'white', fontWeight: 800, fontSize: 'clamp(1.5rem, 3.5vw, 2.2rem)', lineHeight: 1.2, letterSpacing: -0.5, margin: '4px 0 8px' },
  heroSubline: { color: 'rgba(255,255,255,0.88)', fontWeight: 600, fontSize: 15, letterSpacing: 0.2, margin: 0 },

  main: { maxWidth: 900, margin: '0 auto', width: '100%', padding: 'clamp(1rem, 3vw, 1.5rem) clamp(1rem, 4vw, 2.5rem) clamp(2rem, 5vw, 3.5rem)', boxSizing: 'border-box' },
  backBtn: {
    borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: '1.5px solid #d0d4da', background: 'white', color: '#444', marginBottom: '1.5rem',
  },

  introSection: {
    background: 'white', borderRadius: 12, border: '1px solid #e4e6ea',
    padding: 'clamp(1.25rem, 3vw, 2rem)', marginBottom: '1.5rem',
  },
  h2: { fontSize: 19, margin: '0 0 10px', color: '#203864' },
  p: { fontSize: 14.5, lineHeight: 1.65, color: '#333', margin: '0 0 12px' },

  shotSection: {
    display: 'flex', gap: 'clamp(1rem, 3vw, 2rem)', alignItems: 'center',
    background: 'white', borderRadius: 12, border: '1px solid #e4e6ea',
    padding: 'clamp(1.25rem, 3vw, 2rem)', marginBottom: '1.5rem',
  },
  shotText: { flex: '1 1 340px', minWidth: 260 },
  stepLabel: {
    display: 'inline-block', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
    color: '#2F5597', background: '#eef1f8', borderRadius: 999, padding: '3px 10px', marginBottom: 8,
  },
  shotFigure: { flex: '1 1 400px', minWidth: 280, maxWidth: 480, margin: 0 },
  shotImg: {
    width: '100%', display: 'block', borderRadius: 10, border: '1px solid #e0e3e9',
    boxShadow: '0 4px 16px rgba(32, 56, 100, 0.12)',
  },
  shotCaption: { fontSize: 12.5, color: '#6c6f76', marginTop: 8, lineHeight: 1.4 },

  closingSection: {
    textAlign: 'center', background: 'linear-gradient(160deg, #203864 0%, #2F5597 100%)',
    borderRadius: 12, padding: 'clamp(1.5rem, 4vw, 2.5rem)', color: 'white',
  },
  ctaBtn: {
    marginTop: 8, border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 14, fontWeight: 700,
    cursor: 'pointer', background: 'white', color: '#203864',
  },
};

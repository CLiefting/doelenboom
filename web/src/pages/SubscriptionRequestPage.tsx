import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { PriceQuote, PublicModule, PublicTier } from '../types';

// Publieke aanvraagpagina ("nieuw abonnement aanvragen") — zie
// doelenboom_licentiemodel.md §9. Ongeauthenticeerd, bereikbaar via een link
// op LoginPage (App.tsx regelt de omschakeling, dit component zelf weet
// niets van sessies). Bij indienen ontstaat direct een tenant + admin-account
// (proefperiode van 14 dagen) — de aanvrager kan na het succesbericht meteen
// inloggen met het zelfgekozen wachtwoord.
export default function SubscriptionRequestPage({ onBack, onSubmitted }: { onBack: () => void; onSubmitted: (email: string) => void }) {
  const [tiers, setTiers] = useState<PublicTier[] | null>(null);
  const [modules, setModules] = useState<PublicModule[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.subscriptionTiers().then(setTiers).catch((err) => setError(errMsg(err)));
    api.subscriptionModules().then(setModules).catch((err) => setError(errMsg(err)));
  }, []);

  const [tierId, setTierId] = useState<number | null>(null);
  const [selectedModules, setSelectedModules] = useState<Set<string>>(new Set());
  const [quote, setQuote] = useState<PriceQuote | null>(null);
  const selectedTier = tiers?.find((t) => t.id === tierId) ?? null;

  useEffect(() => {
    if (tierId == null) {
      setQuote(null);
      return;
    }
    // Bij het wisselen van tier vuurt dit effect eerst nog één keer met de
    // (op dat moment nog niet bijgewerkte) modules van de VORIGE tier —
    // pas de render erna heeft de aparte reset-modules-useEffect hieronder
    // selectedModules al leeggemaakt/op "alles" gezet. Dat geeft twee vlak
    // na elkaar vurende requests voor dezelfde tier; zonder deze
    // cancelled-guard kon het eerste (verouderde) antwoord later terug-
    // komen dan het tweede en zo de juiste prijsopgave weer overschrijven
    // met een verouderde (bv. nog met een module-opslag die niet meer
    // aangevinkt staat).
    let cancelled = false;
    api
      .subscriptionPriceForTier(tierId, [...selectedModules])
      .then((q) => {
        if (!cancelled) setQuote(q);
      })
      .catch(() => {
        if (!cancelled) setQuote(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tierId, [...selectedModules].sort().join(',')]);

  const [organizationName, setOrganizationName] = useState('');
  const [applicantName, setApplicantName] = useState('');
  const [applicantEmail, setApplicantEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);

  function toggleModule(key: string) {
    setSelectedModules((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Bij een tier met allModulesIncluded (bv. Evaluatie) is er niets te kiezen
  // — vink meteen alle op dat moment bestaande modules aan, zodat de
  // aanvrager ze aangevinkt ziet staan i.p.v. te moeten afleiden uit een
  // los tekstregeltje dat ze toch al meegenomen worden (Charles: "vink
  // direct alle modules meteen aan"). Bij het wisselen NAAR een gewone tier
  // wordt de selectie weer leeggemaakt, zodat een eerder geforceerde
  // "alle modules"-selectie niet blijft hangen en de prijsopgave van die
  // andere tier scheeftrekt.
  useEffect(() => {
    if (tierId == null) return;
    if (selectedTier?.allModulesIncluded && modules) {
      setSelectedModules(new Set(modules.map((m) => m.key)));
    } else {
      setSelectedModules(new Set());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tierId, modules]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (tierId == null) return setError('Kies een abonnement.');
    if (password.length < 8) return setError('Wachtwoord moet minstens 8 tekens zijn.');
    if (password !== confirmPassword) return setError('Wachtwoord en bevestiging komen niet overeen.');

    setBusy(true);
    try {
      await api.createSubscriptionRequest({
        organizationName: organizationName.trim(),
        applicantName: applicantName.trim(),
        applicantEmail: applicantEmail.trim(),
        password,
        tierId,
        moduleKeys: [...selectedModules],
      });
      onSubmitted(applicantEmail.trim());
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  function renderTierCard(t: PublicTier) {
    const accent = tierAccent(t.name);
    const selected = tierId === t.id;
    return (
      <button
        type="button"
        key={t.id}
        onClick={() => setTierId(t.id)}
        style={{
          ...styles.tierCard,
          ...(accent ? { borderTopColor: accent.border, background: selected ? styles.tierCardSelected.background : accent.bg } : {}),
          ...(selected ? styles.tierCardSelected : {}),
        }}
      >
        <div style={{ ...styles.tierName, ...(accent ? { color: accent.text } : {}) }}>{t.name}</div>
        <div style={styles.tierMeta}>
          max {t.maxAdmins} admin{t.maxAdmins === 1 ? '' : 's'}, max {t.maxBomen} doelenbomen
        </div>
        {(t.trialDays != null || t.allModulesIncluded) && (
          <div style={styles.tierBadgeRow}>
            {t.trialDays != null && (
              <span style={{ ...styles.tierBadge, ...(accent ? { color: accent.text, background: accent.bg, borderColor: accent.border } : {}) }}>
                {t.trialDays} dagen proef
              </span>
            )}
            {t.allModulesIncluded && (
              <span style={{ ...styles.tierBadge, ...(accent ? { color: accent.text, background: accent.bg, borderColor: accent.border } : {}) }}>
                ✓ alle modules
              </span>
            )}
          </div>
        )}
        {t.currentPriceEur != null && (
          Number(t.currentPriceEur) === 0 ? (
            <div style={{ ...styles.tierPriceFree, ...(accent ? { color: accent.text } : {}) }}>Gratis</div>
          ) : (
            <>
              <div style={styles.tierPrice}>€ {Number(t.currentPriceEur).toLocaleString('nl-NL')} / jaar</div>
              <div style={styles.tierPriceBtw}>
                € {(Number(t.currentPriceEur) * 1.21).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} incl. BTW (21%)
              </div>
            </>
          )
        )}
      </button>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <button onClick={onBack} style={styles.backLink} type="button">
          ← Terug naar inloggen
        </button>
        <h1 style={styles.title}>Nieuw abonnement aanvragen</h1>
        <p style={styles.subtitle}>
          Kies een abonnement, vul je gegevens in en je krijgt direct een proefaccount voor{' '}
          {selectedTier?.trialDays ?? 14} dagen — meteen aan de slag, betaling regelen we daarna.
        </p>

        {error && <p style={styles.error}>{error}</p>}
        {!tiers && <p style={styles.muted}>Laden…</p>}

        <form onSubmit={handleSubmit} style={styles.form}>
          {tiers && (() => {
            // Verdeeld over twee rijen i.p.v. één rij die organisch wrapt op
            // schermbreedte (dat liet voorheen willekeurig 1 tegel eenzaam op
            // een tweede regel vallen): de eerste twee tiers (op sort_order —
            // op dit moment Evaluatie en Single-Use) samen op de eerste rij,
            // de rest daaronder. Puur op positie, niet op naam, zodat dit ook
            // blijft kloppen als een sysadmin de tierset later wijzigt.
            const firstRow = tiers.slice(0, 2);
            const secondRow = tiers.slice(2);
            // Beide rijen delen hetzelfde aantal kolommen (het aantal van de
            // langste rij) zodat de tegels op de eerste rij precies even
            // breed zijn als die op de tweede — de eerste rij vult dan
            // simpelweg niet alle kolommen (lege ruimte rechts) i.p.v. dat
            // haar 2 tegels tot de volle kaartbreedte uitrekken.
            const cols = Math.max(firstRow.length, secondRow.length, 1);
            const rowStyle = { ...styles.tierGrid, gridTemplateColumns: `repeat(${cols}, minmax(150px, 1fr))` };
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={rowStyle}>{firstRow.map(renderTierCard)}</div>
                {secondRow.length > 0 && <div style={rowStyle}>{secondRow.map(renderTierCard)}</div>}
              </div>
            );
          })()}

          {/* Alles vanaf hier op leesbare regelbreedte houden (i.t.t. de
              tiergrid hierboven, die juist de volle, bredere kaartbreedte
              gebruikt zodat de 5 tiles naast elkaar passen). */}
          <div style={styles.narrowSection}>
            {quote && quote.tierPriceEur != null && (
              <div style={styles.priceBox}>
                {/* Bij een tier die per saldo gratis is (Evaluatie: tierPriceEur
                    0 en dus ook altijd 0% moduleopslag) voegt de itemisering
                    hieronder niets toe naast de "Gratis"-regel — die wordt dan
                    overgeslagen zodat er niet twee keer hetzelfde staat. */}
                {!(quote.finalPriceEur === 0 && !quote.offer) && (
                  <>
                    <div style={styles.priceLineItem}>Abonnement: € {quote.tierPriceEur.toLocaleString('nl-NL')} / jaar</div>
                    {quote.moduleSurcharges.map((s) => (
                      <div key={s.moduleKey} style={styles.priceLineItem}>
                        + {s.moduleName} ({s.surchargePct}% opslag): € {s.amountEur.toLocaleString('nl-NL')} / jaar
                      </div>
                    ))}
                    {quote.moduleSurcharges.length > 0 && quote.subtotalEur != null && (
                      <div style={styles.priceLineItem}>Subtotaal: € {quote.subtotalEur.toLocaleString('nl-NL')} / jaar</div>
                    )}
                  </>
                )}
                {quote.offer ? (
                  <>
                    <div style={styles.priceStrike}>€ {quote.subtotalEur?.toLocaleString('nl-NL')} / jaar</div>
                    <div style={styles.priceFinal}>
                      {quote.btwVrij
                        ? `€ ${quote.subtotalEur?.toLocaleString('nl-NL')} / jaar, zonder BTW`
                        : `€ ${quote.finalPriceEur?.toLocaleString('nl-NL')} / jaar`}{' '}
                      <span style={styles.offerBadge}>{quote.offer.name}</span>
                    </div>
                  </>
                ) : (
                  <div style={{ ...styles.priceFinal, ...(quote.finalPriceEur === 0 ? { color: '#2F9E44' } : {}) }}>
                    {quote.finalPriceEur === 0 ? 'Gratis' : `€ ${quote.finalPriceEur?.toLocaleString('nl-NL')} / jaar`}
                  </div>
                )}
                {!quote.btwVrij && quote.finalPriceEur != null && quote.finalPriceEur > 0 && (
                  <div style={styles.priceBtwLine}>
                    € {(quote.finalPriceEur * 1.21).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} incl. BTW (21%)
                  </div>
                )}
              </div>
            )}

            {modules && modules.length > 0 && (() => {
              const forced = !!selectedTier?.allModulesIncluded;
              return (
                <div>
                  <p style={styles.sectionLabel}>{forced ? 'Modules (alle inbegrepen)' : 'Optionele modules'}</p>
                  {forced && (
                    <p style={{ margin: '0 0 6px', fontSize: 12, color: '#6c6f76' }}>
                      Bij dit abonnement zijn alle modules automatisch inbegrepen — hieronder alvast aangevinkt, er
                      hoeft niets apart gekozen te worden.
                    </p>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {modules.map((m) => (
                      <label key={m.id} style={{ ...styles.moduleRow, ...(forced ? { opacity: 0.75 } : {}) }}>
                        <input
                          type="checkbox"
                          checked={forced || selectedModules.has(m.key)}
                          disabled={forced}
                          onChange={() => !forced && toggleModule(m.key)}
                        />
                        <span>
                          <strong>{m.name}</strong>
                          {m.currentSurchargePct != null && (
                            <span style={{ opacity: 0.7 }}> (+{Number(m.currentSurchargePct).toLocaleString('nl-NL')}%)</span>
                          )}
                          {m.description && <span style={{ opacity: 0.7 }}> — {m.description}</span>}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })()}

            <p style={styles.sectionLabel}>Jouw gegevens</p>
            <label style={styles.label}>
              Organisatienaam
              <input style={styles.input} required value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} />
            </label>
            <label style={styles.label}>
              Jouw naam
              <input style={styles.input} required value={applicantName} onChange={(e) => setApplicantName(e.target.value)} />
            </label>
            <label style={styles.label}>
              E-mail
              <input
                style={styles.input}
                type="email"
                required
                value={applicantEmail}
                onChange={(e) => setApplicantEmail(e.target.value)}
              />
            </label>
            <label style={styles.label}>
              Wachtwoord
              <input style={styles.input} type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label style={styles.label}>
              Wachtwoord bevestigen
              <input
                style={styles.input}
                type="password"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </label>

            <button style={styles.button} type="submit" disabled={busy}>
              {busy ? 'Bezig…' : 'Aanvraag indienen'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Er ging iets mis.';
}

// Metaal-accenten per tiernaam — Single-Use en eventuele eigen/maatwerktiers
// krijgen bewust geen accent (vallen terug op de neutrale kaartstijl). Evaluatie
// krijgt bewust geen metaalkleur maar hetzelfde groen als elders in de app voor
// "gratis"/"nu geldig" (zie LicenseCatalogPage.tsx currentBadge/historyRowCurrent)
// — zo oogt de gratis proeftier meteen als een uitnodigende, positieve keuze.
const TIER_ACCENTS: Record<string, { border: string; bg: string; text: string }> = {
  evaluatie: { border: '#2F9E44', bg: '#F1FBF3', text: '#1F7A34' },
  brons: { border: '#B08D57', bg: '#FBF3EA', text: '#8C5A2B' },
  zilver: { border: '#9FA3A8', bg: '#F4F5F6', text: '#5B6066' },
  goud: { border: '#D4AF37', bg: '#FFFBEA', text: '#8A6D1B' },
  diamant: { border: '#4FC3D9', bg: '#EAFBFE', text: '#1D7A8C' },
};
function tierAccent(name: string) {
  return TIER_ACCENTS[name.trim().toLowerCase()] ?? null;
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    justifyContent: 'center',
    padding: 'clamp(1rem, 4vw, 3rem) 1rem',
    background: '#eef1f8',
    fontFamily: 'system-ui, sans-serif',
    boxSizing: 'border-box',
  },
  card: {
    background: 'white',
    borderRadius: 12,
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    padding: 'clamp(1.25rem, 4vw, 2.5rem)',
    width: '100%',
    // Breder dan de rest van het formulier (dat blijft op leesbare
    // regelbreedte) zodat de tier-tiles hieronder (verdeeld over twee rijen,
    // zie de renderTierCard-aanroepen) ruim naast elkaar passen — zie
    // tierGrid, dat zelf geen eigen maxWidth heeft en dus meeschaalt met
    // deze kaart.
    maxWidth: 900,
    boxSizing: 'border-box',
    height: 'fit-content',
  },
  backLink: { border: 'none', background: 'none', color: '#2F5597', cursor: 'pointer', padding: 0, fontSize: 13.5, marginBottom: 12 },
  title: { margin: '0 0 6px', color: '#203864' },
  subtitle: { margin: '0 0 1.25rem', color: '#6c6f76', fontSize: 14, lineHeight: 1.5 },
  muted: { color: '#9aa0a8', fontSize: 14 },
  error: { color: '#DC3545', fontSize: 13.5, background: '#FBE9EA', border: '1px solid #f3c2c6', borderRadius: 6, padding: '0.5rem 0.75rem' },
  form: { display: 'flex', flexDirection: 'column', gap: 14 },
  // Houdt de rest van het formulier (prijsopgave, modules, persoonsgegevens)
  // op leesbare regelbreedte, los van de bredere kaart hierboven (zie card.maxWidth).
  narrowSection: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 480, margin: '0 auto', width: '100%', boxSizing: 'border-box' },
  // gridTemplateColumns wordt per rij overschreven (zie de rowStyle-berekening
  // hierboven, die beide rijen op hetzelfde aantal kolommen zet) — dit is
  // alleen de fallback-basisstijl.
  tierGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 },
  tierCard: {
    textAlign: 'left', border: '1px solid #e4e6ea', borderTop: '4px solid #e4e6ea', borderRadius: 10,
    padding: '0.75rem 0.9rem', background: 'white', cursor: 'pointer', display: 'flex', flexDirection: 'column',
    gap: 3,
  },
  // Zet bewust alléén de zij-/onderrand blauw (longhand-properties, geen
  // "border"-shorthand) — de bovenrand houdt zo zijn metaal-accentkleur
  // (zie tierAccent hierboven) ook wanneer de tile geselecteerd is.
  tierCardSelected: {
    borderLeftColor: '#2F5597', borderRightColor: '#2F5597', borderBottomColor: '#2F5597',
    borderLeftWidth: 2, borderRightWidth: 2, borderBottomWidth: 2, borderTopWidth: 4,
    background: '#f0f4fc',
  },
  tierName: { fontWeight: 700, color: '#203864', fontSize: 14.5 },
  tierMeta: { fontSize: 11.5, color: '#6c6f76' },
  tierBadgeRow: { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 1 },
  tierBadge: {
    fontSize: 10, fontWeight: 600, color: '#5B6066', background: '#F4F5F6',
    border: '1px solid #e4e6ea', borderRadius: 999, padding: '2px 7px', whiteSpace: 'nowrap',
  },
  tierPrice: { fontSize: 13, color: '#2F5597', fontWeight: 600, marginTop: 4 },
  // Iets groter/steviger dan tierPrice: "Gratis" is bij Evaluatie het hele
  // verkoopargument, dat mag zichtbaar zwaarder wegen dan een gewoon bedrag.
  tierPriceFree: { fontSize: 16, fontWeight: 700, color: '#2F9E44', marginTop: 4 },
  tierPriceBtw: { fontSize: 10.5, color: '#9aa0a8' },
  priceBox: { background: '#f4f5f7', borderRadius: 8, padding: '0.75rem 1rem' },
  priceLineItem: { fontSize: 12, color: '#6c6f76' },
  priceStrike: { fontSize: 13, color: '#9aa0a8', textDecoration: 'line-through' },
  priceFinal: { fontSize: 16, fontWeight: 700, color: '#203864' },
  priceBtwLine: { fontSize: 11.5, color: '#9aa0a8', marginTop: 2 },
  offerBadge: { fontSize: 11, fontWeight: 600, color: '#946200', background: '#FFF3CD', border: '1px solid #FFE69C', borderRadius: 999, padding: '2px 8px', marginLeft: 6 },
  sectionLabel: { margin: '0.5rem 0 0', fontSize: 13, fontWeight: 700, color: '#203864' },
  moduleRow: { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13.5 },
  label: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14, color: '#333' },
  input: { padding: '0.5rem', borderRadius: 6, border: '1px solid #d0d4da', fontSize: 16, boxSizing: 'border-box' },
  button: { marginTop: '0.5rem', padding: '0.65rem', borderRadius: 6, border: 'none', background: '#2F5597', color: 'white', fontSize: 14.5, fontWeight: 600, cursor: 'pointer' },
};

import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { ModuleDef, ModuleSurcharge, Offer, OfferKind, Tier, TierPrice } from '../types';

// Sysadmin-only catalogusbeheer voor het licentiemodel: tiers (naam + max.
// admins/bomen + eigen prijsGESCHIEDENIS), modules (key + naam + omschrijving
// + eigen opslagpercentage-geschiedenis) en aanbiedingen (tijdelijke
// kortingen/BTW-vrijstellingen per tier) — zie doelenboom_licentiemodel.md
// §9. Los van de toewijzing PER tenant (welk tier/welke modules een
// specifieke klant heeft), dat gebeurt in TenantLicensePanel binnen
// TenantManagementPage. Prijzen/opslagen/aanbiedingen hierboven voeden de
// publieke aanvraagpagina (SubscriptionRequestPage) — dit wijkt bewust af van
// het oorspronkelijke §7 ("geen prijsveld"), zie de toelichting bovenaan
// doelenboom_licentiemodel.md §9. Een tier/module heeft NIET één prijsveld:
// een abonnement heeft door de tijd heen meerdere prijzen (bv. een ander
// tarief per kalenderjaar), dus prijzen/opslagen zijn een eigen, uitklapbare
// geschiedenis per tier/module (zie TierPriceSection/ModuleSurchargeSection),
// met duidelijke markering van welke periode op dit moment geldig is.
export default function LicenseCatalogPage({ token, onBack }: { token: string; onBack: () => void }) {
  const [tiers, setTiers] = useState<Tier[] | null>(null);
  const [modules, setModules] = useState<ModuleDef[] | null>(null);
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function loadTiers() {
    api.tiers(token).then(setTiers).catch((err) => setError(errMsg(err)));
  }
  function loadModules() {
    api.modules(token).then(setModules).catch((err) => setError(errMsg(err)));
  }
  function loadOffers() {
    api.offers(token).then(setOffers).catch((err) => setError(errMsg(err)));
  }
  useEffect(() => {
    loadTiers();
    loadModules();
    loadOffers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Licentiecatalogus</h1>
          <p style={styles.subtitle}>
            Tiers, modules en aanbiedingen beheren — welk tier/welke modules een specifieke tenant heeft, stel je in
            bij "Tenantbeheer" → Licentie. Prijzen en aanbiedingen hieronder voeden de publieke aanvraagpagina.
          </p>
        </div>
        <button onClick={onBack} style={btnStyle('ghost')}>← Terug</button>
      </header>

      {error && <p style={styles.error}>{error}</p>}

      <section style={styles.section}>
        <h2 style={styles.h2}>Tiers</h2>
        {!tiers && <p style={styles.muted}>Laden…</p>}
        {tiers && (
          <TierList
            token={token}
            tiers={tiers}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            onChanged={loadTiers}
          />
        )}
      </section>

      <section style={styles.section}>
        <h2 style={styles.h2}>Modules</h2>
        {!modules && <p style={styles.muted}>Laden…</p>}
        {modules && (
          <ModuleList
            token={token}
            modules={modules}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            onChanged={loadModules}
          />
        )}
      </section>

      <section style={styles.section}>
        <h2 style={styles.h2}>Aanbiedingen</h2>
        <p style={{ fontSize: 12.5, color: '#6c6f76', margin: '-6px 0 12px' }}>
          Tijdelijk, per tier gekoppeld (bv. "eerste jaar 33% korting", "nu zonder BTW") — verschijnt automatisch op
          de aanvraagpagina zolang de geldigheidsperiode loopt.
        </p>
        {!offers && <p style={styles.muted}>Laden…</p>}
        {offers && tiers && (
          <OfferList
            token={token}
            offers={offers}
            tiers={tiers}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            onChanged={loadOffers}
          />
        )}
      </section>
    </main>
  );
}

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Er ging iets mis.';
}

function TierList({
  token,
  tiers,
  busy,
  setBusy,
  setError,
  onChanged,
}: {
  token: string;
  tiers: Tier[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onChanged: () => void;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [pricesOpenFor, setPricesOpenFor] = useState<number | null>(null);
  const [currentPrices, setCurrentPrices] = useState<Record<number, TierPrice | undefined>>({});

  function loadCurrentPrices() {
    Promise.all(
      tiers.map((t) =>
        api
          .tierPrices(token, t.id)
          .then((prices) => [t.id, prices.find((p) => isCurrentPeriod(p.validFrom, p.validUntil))] as const)
          .catch(() => [t.id, undefined] as const)
      )
    ).then((entries) => setCurrentPrices(Object.fromEntries(entries)));
  }
  useEffect(loadCurrentPrices, [token, tiers.map((t) => t.id).join(',')]);

  async function remove(t: Tier) {
    const ok = window.confirm(
      `Tier "${t.name}" verwijderen? Tenants die dit tier hadden vallen terug op "geen licentie" (onbeperkt).`
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteTier(token, t.id);
      onChanged();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {tiers.length === 0 && <p style={styles.muted}>Nog geen tiers.</p>}
      {tiers.map((t) =>
        editingId === t.id ? (
          <TierForm
            key={t.id}
            token={token}
            initial={t}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            onSaved={() => {
              setEditingId(null);
              onChanged();
            }}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <div key={t.id} style={styles.rowGroup}>
            <div style={styles.row}>
              <div>
                <strong>{t.name}</strong>{' '}
                <span style={{ opacity: 0.7, fontSize: 12.5 }}>
                  — max {t.maxAdmins} admin{t.maxAdmins === 1 ? '' : 's'}, max {t.maxBomen} doelenbomen
                  {t.trialDays != null && `, ${t.trialDays} dagen proef`}
                  {t.allModulesIncluded && ', alle modules inbegrepen'}
                </span>
                {currentPrices[t.id] ? (
                  <span style={styles.currentPriceInline}>
                    € {Number(currentPrices[t.id]!.priceEur).toLocaleString('nl-NL')} / jaar
                  </span>
                ) : (
                  <span style={styles.noPriceInline}>geen huidige prijs</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  disabled={busy}
                  onClick={() => setPricesOpenFor(pricesOpenFor === t.id ? null : t.id)}
                  style={btnStyle('ghost')}
                >
                  {pricesOpenFor === t.id ? 'Prijzen ▲' : 'Prijzen ▾'}
                </button>
                <button disabled={busy} onClick={() => setEditingId(t.id)} style={btnStyle('ghost')}>
                  Bewerken
                </button>
                <button disabled={busy} onClick={() => remove(t)} style={btnStyle('danger-text')}>
                  Verwijderen
                </button>
              </div>
            </div>
            {pricesOpenFor === t.id && (
              <TierPriceSection
                token={token}
                tierId={t.id}
                busy={busy}
                setBusy={setBusy}
                setError={setError}
                onPriceListChanged={loadCurrentPrices}
              />
            )}
          </div>
        )
      )}
      <TierForm
        token={token}
        initial={null}
        busy={busy}
        setBusy={setBusy}
        setError={setError}
        onSaved={onChanged}
        onCancel={null}
      />
    </div>
  );
}

function TierForm({
  token,
  initial,
  busy,
  setBusy,
  setError,
  onSaved,
  onCancel,
}: {
  token: string;
  initial: Tier | null;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onSaved: () => void;
  onCancel: (() => void) | null;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [maxAdmins, setMaxAdmins] = useState(String(initial?.maxAdmins ?? ''));
  const [maxBomen, setMaxBomen] = useState(String(initial?.maxBomen ?? ''));
  const [sortOrder, setSortOrder] = useState(String(initial?.sortOrder ?? 0));
  const [trialDays, setTrialDays] = useState(initial?.trialDays != null ? String(initial.trialDays) : '');
  const [allModulesIncluded, setAllModulesIncluded] = useState(initial?.allModulesIncluded ?? false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const admins = Number(maxAdmins);
    const bomen = Number(maxBomen);
    const order = Number(sortOrder) || 0;
    if (!name.trim()) return setError('Naam is verplicht.');
    if (!Number.isFinite(admins) || admins <= 0) return setError('Max. admins moet een positief getal zijn.');
    if (!Number.isFinite(bomen) || bomen <= 0) return setError('Max. bomen moet een positief getal zijn.');
    let trialDaysValue: number | null = null;
    if (trialDays.trim()) {
      trialDaysValue = Number(trialDays);
      if (!Number.isFinite(trialDaysValue) || trialDaysValue <= 0) {
        return setError('Proefdagen moet een positief getal zijn (of leeg voor de standaardduur).');
      }
    }

    setBusy(true);
    setError(null);
    try {
      if (initial) {
        await api.updateTier(token, initial.id, {
          name: name.trim(), maxAdmins: admins, maxBomen: bomen, sortOrder: order,
          trialDays: trialDaysValue, allModulesIncluded,
        });
      } else {
        await api.createTier(token, {
          name: name.trim(), maxAdmins: admins, maxBomen: bomen, sortOrder: order,
          trialDays: trialDaysValue, allModulesIncluded,
        });
        setName('');
        setMaxAdmins('');
        setMaxBomen('');
        setSortOrder('0');
        setTrialDays('');
        setAllModulesIncluded(false);
      }
      onSaved();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={styles.inlineForm}>
      <input style={styles.input} placeholder="naam (bv. Brons)" required value={name} onChange={(e) => setName(e.target.value)} />
      <input
        style={{ ...styles.input, width: 130 }} type="number" min={1} placeholder="max. admins" required
        value={maxAdmins} onChange={(e) => setMaxAdmins(e.target.value)}
      />
      <input
        style={{ ...styles.input, width: 130 }} type="number" min={1} placeholder="max. bomen" required
        value={maxBomen} onChange={(e) => setMaxBomen(e.target.value)}
      />
      <input
        style={{ ...styles.input, width: 110 }} type="number" placeholder="volgorde" value={sortOrder}
        onChange={(e) => setSortOrder(e.target.value)}
      />
      <input
        style={{ ...styles.input, width: 140 }} type="number" min={1} placeholder="proefdagen (std. 14)"
        value={trialDays} onChange={(e) => setTrialDays(e.target.value)}
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12.5 }}>
        <input type="checkbox" checked={allModulesIncluded} onChange={(e) => setAllModulesIncluded(e.target.checked)} />
        alle modules inbegrepen
      </label>
      <button style={btnStyle('primary')} type="submit" disabled={busy}>
        {initial ? 'Opslaan' : '+ Tier toevoegen'}
      </button>
      {onCancel && (
        <button type="button" style={btnStyle('ghost')} disabled={busy} onClick={onCancel}>
          Annuleren
        </button>
      )}
    </form>
  );
}

function isCurrentPeriod(validFrom: string, validUntil: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return today >= validFrom && today <= validUntil;
}

function TierPriceSection({
  token,
  tierId,
  busy,
  setBusy,
  setError,
  onPriceListChanged,
}: {
  token: string;
  tierId: number;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onPriceListChanged: () => void;
}) {
  const [prices, setPrices] = useState<TierPrice[] | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  function load() {
    api.tierPrices(token, tierId).then(setPrices).catch((err) => setError(errMsg(err)));
    onPriceListChanged();
  }
  useEffect(load, [token, tierId]);

  async function remove(p: TierPrice) {
    const ok = window.confirm(`Prijsperiode ${p.validFrom} t/m ${p.validUntil} verwijderen?`);
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteTierPrice(token, p.id);
      load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  const sorted = prices ? [...prices].sort((a, b) => b.validFrom.localeCompare(a.validFrom)) : null;

  return (
    <div style={styles.historyBox}>
      {!sorted && <p style={styles.muted}>Laden…</p>}
      {sorted && sorted.length === 0 && !adding && <p style={styles.muted}>Nog geen prijzen ingesteld.</p>}
      {sorted && sorted.map((p) =>
        editingId === p.id ? (
          <TierPriceForm
            key={p.id}
            token={token}
            tierId={tierId}
            initial={p}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            onSaved={() => {
              setEditingId(null);
              load();
            }}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <div key={p.id} style={{ ...styles.historyRow, ...(isCurrentPeriod(p.validFrom, p.validUntil) ? styles.historyRowCurrent : {}) }}>
            <div>
              € {Number(p.priceEur).toLocaleString('nl-NL')} / jaar
              <span style={{ opacity: 0.7, fontSize: 12, marginLeft: 8 }}>
                {p.validFrom} t/m {p.validUntil}
              </span>
              {isCurrentPeriod(p.validFrom, p.validUntil) && <span style={styles.currentBadge}>huidig geldig</span>}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button disabled={busy} onClick={() => setEditingId(p.id)} style={btnStyle('ghost')}>
                Bewerken
              </button>
              <button disabled={busy} onClick={() => remove(p)} style={btnStyle('danger-text')}>
                Verwijderen
              </button>
            </div>
          </div>
        )
      )}
      {adding ? (
        <TierPriceForm
          token={token}
          tierId={tierId}
          initial={null}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          onSaved={() => {
            setAdding(false);
            load();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button type="button" disabled={busy} onClick={() => setAdding(true)} style={btnStyle('ghost')}>
          + Prijsperiode toevoegen
        </button>
      )}
    </div>
  );
}

function TierPriceForm({
  token,
  tierId,
  initial,
  busy,
  setBusy,
  setError,
  onSaved,
  onCancel,
}: {
  token: string;
  tierId: number;
  initial: TierPrice | null;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [priceEur, setPriceEur] = useState(initial?.priceEur ?? '');
  const [validFrom, setValidFrom] = useState(initial?.validFrom ?? '');
  const [validUntil, setValidUntil] = useState(initial?.validUntil ?? '');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const price = Number(priceEur);
    if (!priceEur.trim() || !Number.isFinite(price) || price < 0) return setError('Prijs moet een positief getal zijn.');
    if (!validFrom || !validUntil) return setError('Geldig-vanaf en geldig-tot zijn verplicht.');
    if (validUntil < validFrom) return setError('Geldig-tot mag niet vóór geldig-vanaf liggen.');

    setBusy(true);
    setError(null);
    try {
      if (initial) {
        await api.updateTierPrice(token, initial.id, { priceEur: price, validFrom, validUntil });
      } else {
        await api.createTierPrice(token, tierId, { priceEur: price, validFrom, validUntil });
      }
      onSaved();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={styles.inlineForm}>
      <input
        style={{ ...styles.input, width: 110 }} type="number" min={0} step="0.01" placeholder="prijs €/jaar" required
        value={priceEur} onChange={(e) => setPriceEur(e.target.value)}
      />
      <label style={styles.dateLabel}>
        geldig vanaf
        <input style={{ ...styles.input, width: 140 }} type="date" required value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
      </label>
      <label style={styles.dateLabel}>
        geldig tot
        <input style={{ ...styles.input, width: 140 }} type="date" required value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
      </label>
      <button style={btnStyle('primary')} type="submit" disabled={busy}>
        {initial ? 'Opslaan' : '+ Toevoegen'}
      </button>
      <button type="button" style={btnStyle('ghost')} disabled={busy} onClick={onCancel}>
        Annuleren
      </button>
    </form>
  );
}

function ModuleList({
  token,
  modules,
  busy,
  setBusy,
  setError,
  onChanged,
}: {
  token: string;
  modules: ModuleDef[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onChanged: () => void;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [surchargesOpenFor, setSurchargesOpenFor] = useState<number | null>(null);
  const [currentSurcharges, setCurrentSurcharges] = useState<Record<number, ModuleSurcharge | undefined>>({});

  function loadCurrentSurcharges() {
    Promise.all(
      modules.map((m) =>
        api
          .moduleSurcharges(token, m.id)
          .then((list) => [m.id, list.find((s) => isCurrentPeriod(s.validFrom, s.validUntil))] as const)
          .catch(() => [m.id, undefined] as const)
      )
    ).then((entries) => setCurrentSurcharges(Object.fromEntries(entries)));
  }
  useEffect(loadCurrentSurcharges, [token, modules.map((m) => m.id).join(',')]);

  async function remove(m: ModuleDef) {
    const ok = window.confirm(
      `Module "${m.name}" verwijderen? Dit ontneemt alle tenants die 'm hadden meteen de bijbehorende functies.`
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteModule(token, m.id);
      onChanged();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {modules.length === 0 && <p style={styles.muted}>Nog geen modules.</p>}
      {modules.map((m) =>
        editingId === m.id ? (
          <ModuleForm
            key={m.id}
            token={token}
            initial={m}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            onSaved={() => {
              setEditingId(null);
              onChanged();
            }}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <div key={m.id} style={styles.rowGroup}>
            <div style={styles.row}>
              <div>
                <strong>{m.name}</strong> <span style={{ opacity: 0.6, fontSize: 12 }}>({m.key})</span>
                {currentSurcharges[m.id] ? (
                  <span style={styles.currentPriceInline}>
                    +{Number(currentSurcharges[m.id]!.surchargePct).toLocaleString('nl-NL')}% opslag
                  </span>
                ) : (
                  <span style={styles.noPriceInline}>geen huidige opslag</span>
                )}
                {m.description && <div style={{ fontSize: 12.5, color: '#6c6f76', marginTop: 2 }}>{m.description}</div>}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  disabled={busy}
                  onClick={() => setSurchargesOpenFor(surchargesOpenFor === m.id ? null : m.id)}
                  style={btnStyle('ghost')}
                >
                  {surchargesOpenFor === m.id ? 'Opslag ▲' : 'Opslag ▾'}
                </button>
                <button disabled={busy} onClick={() => setEditingId(m.id)} style={btnStyle('ghost')}>
                  Bewerken
                </button>
                <button disabled={busy} onClick={() => remove(m)} style={btnStyle('danger-text')}>
                  Verwijderen
                </button>
              </div>
            </div>
            {surchargesOpenFor === m.id && (
              <ModuleSurchargeSection
                token={token}
                moduleId={m.id}
                busy={busy}
                setBusy={setBusy}
                setError={setError}
                onSurchargeListChanged={loadCurrentSurcharges}
              />
            )}
          </div>
        )
      )}
      <ModuleForm token={token} initial={null} busy={busy} setBusy={setBusy} setError={setError} onSaved={onChanged} onCancel={null} />
    </div>
  );
}

function ModuleForm({
  token,
  initial,
  busy,
  setBusy,
  setError,
  onSaved,
  onCancel,
}: {
  token: string;
  initial: ModuleDef | null;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onSaved: () => void;
  onCancel: (() => void) | null;
}) {
  const [key, setKey] = useState(initial?.key ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!initial && !/^[a-z0-9][a-z0-9_-]*$/.test(key.trim())) {
      return setError('Key moet kleine letters/cijfers/koppelteken/underscore zijn (bv. "projecten").');
    }
    if (!name.trim()) return setError('Naam is verplicht.');

    setBusy(true);
    setError(null);
    try {
      if (initial) {
        await api.updateModule(token, initial.id, { name: name.trim(), description });
      } else {
        await api.createModule(token, { key: key.trim().toLowerCase(), name: name.trim(), description });
        setKey('');
        setName('');
        setDescription('');
      }
      onSaved();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={styles.inlineForm}>
      {!initial && (
        <input
          style={{ ...styles.input, width: 140 }} placeholder="key (bv. projecten)" required
          value={key} onChange={(e) => setKey(e.target.value)}
        />
      )}
      <input style={styles.input} placeholder="naam" required value={name} onChange={(e) => setName(e.target.value)} />
      <input
        style={{ ...styles.input, flex: '1 1 260px' }} placeholder="omschrijving (optioneel)" value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <button style={btnStyle('primary')} type="submit" disabled={busy}>
        {initial ? 'Opslaan' : '+ Module toevoegen'}
      </button>
      {onCancel && (
        <button type="button" style={btnStyle('ghost')} disabled={busy} onClick={onCancel}>
          Annuleren
        </button>
      )}
    </form>
  );
}

function ModuleSurchargeSection({
  token,
  moduleId,
  busy,
  setBusy,
  setError,
  onSurchargeListChanged,
}: {
  token: string;
  moduleId: number;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onSurchargeListChanged: () => void;
}) {
  const [surcharges, setSurcharges] = useState<ModuleSurcharge[] | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  function load() {
    api.moduleSurcharges(token, moduleId).then(setSurcharges).catch((err) => setError(errMsg(err)));
    onSurchargeListChanged();
  }
  useEffect(load, [token, moduleId]);

  async function remove(s: ModuleSurcharge) {
    const ok = window.confirm(`Opslagperiode ${s.validFrom} t/m ${s.validUntil} verwijderen?`);
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteModuleSurcharge(token, s.id);
      load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  const sorted = surcharges ? [...surcharges].sort((a, b) => b.validFrom.localeCompare(a.validFrom)) : null;

  return (
    <div style={styles.historyBox}>
      {!sorted && <p style={styles.muted}>Laden…</p>}
      {sorted && sorted.length === 0 && !adding && <p style={styles.muted}>Nog geen opslagpercentages ingesteld.</p>}
      {sorted && sorted.map((s) =>
        editingId === s.id ? (
          <ModuleSurchargeForm
            key={s.id}
            token={token}
            moduleId={moduleId}
            initial={s}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            onSaved={() => {
              setEditingId(null);
              load();
            }}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <div key={s.id} style={{ ...styles.historyRow, ...(isCurrentPeriod(s.validFrom, s.validUntil) ? styles.historyRowCurrent : {}) }}>
            <div>
              {Number(s.surchargePct).toLocaleString('nl-NL')}% opslag
              <span style={{ opacity: 0.7, fontSize: 12, marginLeft: 8 }}>
                {s.validFrom} t/m {s.validUntil}
              </span>
              {isCurrentPeriod(s.validFrom, s.validUntil) && <span style={styles.currentBadge}>huidig geldig</span>}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button disabled={busy} onClick={() => setEditingId(s.id)} style={btnStyle('ghost')}>
                Bewerken
              </button>
              <button disabled={busy} onClick={() => remove(s)} style={btnStyle('danger-text')}>
                Verwijderen
              </button>
            </div>
          </div>
        )
      )}
      {adding ? (
        <ModuleSurchargeForm
          token={token}
          moduleId={moduleId}
          initial={null}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          onSaved={() => {
            setAdding(false);
            load();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button type="button" disabled={busy} onClick={() => setAdding(true)} style={btnStyle('ghost')}>
          + Opslagperiode toevoegen
        </button>
      )}
    </div>
  );
}

function ModuleSurchargeForm({
  token,
  moduleId,
  initial,
  busy,
  setBusy,
  setError,
  onSaved,
  onCancel,
}: {
  token: string;
  moduleId: number;
  initial: ModuleSurcharge | null;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [surchargePct, setSurchargePct] = useState(initial?.surchargePct ?? '');
  const [validFrom, setValidFrom] = useState(initial?.validFrom ?? '');
  const [validUntil, setValidUntil] = useState(initial?.validUntil ?? '');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const pct = Number(surchargePct);
    if (!surchargePct.trim() || !Number.isFinite(pct) || pct < 0) return setError('Opslagpercentage moet een positief getal zijn.');
    if (!validFrom || !validUntil) return setError('Geldig-vanaf en geldig-tot zijn verplicht.');
    if (validUntil < validFrom) return setError('Geldig-tot mag niet vóór geldig-vanaf liggen.');

    setBusy(true);
    setError(null);
    try {
      if (initial) {
        await api.updateModuleSurcharge(token, initial.id, { surchargePct: pct, validFrom, validUntil });
      } else {
        await api.createModuleSurcharge(token, moduleId, { surchargePct: pct, validFrom, validUntil });
      }
      onSaved();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={styles.inlineForm}>
      <input
        style={{ ...styles.input, width: 110 }} type="number" min={0} step="0.01" placeholder="% opslag" required
        value={surchargePct} onChange={(e) => setSurchargePct(e.target.value)}
      />
      <label style={styles.dateLabel}>
        geldig vanaf
        <input style={{ ...styles.input, width: 140 }} type="date" required value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
      </label>
      <label style={styles.dateLabel}>
        geldig tot
        <input style={{ ...styles.input, width: 140 }} type="date" required value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
      </label>
      <button style={btnStyle('primary')} type="submit" disabled={busy}>
        {initial ? 'Opslaan' : '+ Toevoegen'}
      </button>
      <button type="button" style={btnStyle('ghost')} disabled={busy} onClick={onCancel}>
        Annuleren
      </button>
    </form>
  );
}

function OfferList({
  token,
  offers,
  tiers,
  busy,
  setBusy,
  setError,
  onChanged,
}: {
  token: string;
  offers: Offer[];
  tiers: Tier[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onChanged: () => void;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);

  async function remove(o: Offer) {
    const ok = window.confirm(`Aanbieding "${o.name}" verwijderen?`);
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteOffer(token, o.id);
      onChanged();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  function tierNames(o: Offer): string {
    const names = tiers.filter((t) => o.tierIds.includes(t.id)).map((t) => t.name);
    return names.length ? names.join(', ') : '(geen tiers gekoppeld)';
  }

  function describeValue(o: Offer): string {
    if (o.kind === 'percentage') return `${o.value ?? '?'}% korting`;
    if (o.kind === 'fixed_amount') return `€ ${o.value ?? '?'} korting`;
    return 'BTW-vrij';
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {offers.length === 0 && <p style={styles.muted}>Nog geen aanbiedingen.</p>}
      {offers.map((o) =>
        editingId === o.id ? (
          <OfferForm
            key={o.id}
            token={token}
            tiers={tiers}
            initial={o}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            onSaved={() => {
              setEditingId(null);
              onChanged();
            }}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <div key={o.id} style={styles.row}>
            <div>
              <strong>{o.name}</strong>{' '}
              <span style={{ opacity: 0.7, fontSize: 12.5 }}>
                — {describeValue(o)}, geldig {o.validFrom} t/m {o.validUntil}
              </span>
              <div style={{ fontSize: 12, color: '#6c6f76', marginTop: 2 }}>tiers: {tierNames(o)}</div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button disabled={busy} onClick={() => setEditingId(o.id)} style={btnStyle('ghost')}>
                Bewerken
              </button>
              <button disabled={busy} onClick={() => remove(o)} style={btnStyle('danger-text')}>
                Verwijderen
              </button>
            </div>
          </div>
        )
      )}
      <OfferForm token={token} tiers={tiers} initial={null} busy={busy} setBusy={setBusy} setError={setError} onSaved={onChanged} onCancel={null} />
    </div>
  );
}

function OfferForm({
  token,
  tiers,
  initial,
  busy,
  setBusy,
  setError,
  onSaved,
  onCancel,
}: {
  token: string;
  tiers: Tier[];
  initial: Offer | null;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onSaved: () => void;
  onCancel: (() => void) | null;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<OfferKind>(initial?.kind ?? 'percentage');
  const [value, setValue] = useState(initial?.value ?? '');
  const [validFrom, setValidFrom] = useState(initial?.validFrom ?? '');
  const [validUntil, setValidUntil] = useState(initial?.validUntil ?? '');
  const [tierIds, setTierIds] = useState<number[]>(initial?.tierIds ?? []);

  function toggleTier(id: number) {
    setTierIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Naam is verplicht.');
    if (!validFrom || !validUntil) return setError('Geldig-vanaf en geldig-tot zijn verplicht.');
    if (validUntil < validFrom) return setError('Geldig-tot mag niet vóór geldig-vanaf liggen.');
    if (tierIds.length === 0) return setError('Kies minstens één tier waarvoor deze aanbieding geldt.');
    let numValue: number | null = null;
    if (kind !== 'btw_vrij') {
      numValue = value.trim() ? Number(value) : NaN;
      if (!Number.isFinite(numValue) || numValue <= 0) {
        return setError(kind === 'percentage' ? 'Percentage moet een positief getal zijn.' : 'Bedrag moet een positief getal zijn.');
      }
    }

    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), kind, value: numValue, validFrom, validUntil, tierIds };
      if (initial) {
        await api.updateOffer(token, initial.id, body);
      } else {
        await api.createOffer(token, body);
        setName('');
        setKind('percentage');
        setValue('');
        setValidFrom('');
        setValidUntil('');
        setTierIds([]);
      }
      onSaved();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ ...styles.inlineForm, alignItems: 'flex-start' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <input style={styles.input} placeholder="naam (bv. eerste jaar 33% korting)" required value={name} onChange={(e) => setName(e.target.value)} />
        <select style={styles.input} value={kind} onChange={(e) => setKind(e.target.value as OfferKind)}>
          <option value="percentage">percentage korting</option>
          <option value="fixed_amount">vast bedrag korting</option>
          <option value="btw_vrij">BTW-vrij</option>
        </select>
        {kind !== 'btw_vrij' && (
          <input
            style={{ ...styles.input, width: 110 }} type="number" min={0} step="0.01"
            placeholder={kind === 'percentage' ? '% korting' : '€ korting'}
            value={value} onChange={(e) => setValue(e.target.value)}
          />
        )}
        <label style={styles.dateLabel}>
          geldig vanaf
          <input style={{ ...styles.input, width: 140 }} type="date" required value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
        </label>
        <label style={styles.dateLabel}>
          geldig tot
          <input style={{ ...styles.input, width: 140 }} type="date" required value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
        </label>
        <button style={btnStyle('primary')} type="submit" disabled={busy}>
          {initial ? 'Opslaan' : '+ Aanbieding toevoegen'}
        </button>
        {onCancel && (
          <button type="button" style={btnStyle('ghost')} disabled={busy} onClick={onCancel}>
            Annuleren
          </button>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: 12.5 }}>
        {tiers.map((t) => (
          <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={tierIds.includes(t.id)} onChange={() => toggleTier(t.id)} />
            {t.name}
          </label>
        ))}
      </div>
    </form>
  );
}

function btnStyle(kind: 'ghost' | 'primary' | 'danger-text'): React.CSSProperties {
  const base: React.CSSProperties = {
    borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  };
  if (kind === 'ghost') return { ...base, border: '1.5px solid #d0d4da', background: 'white', color: '#444' };
  if (kind === 'danger-text') return { ...base, border: 'none', background: 'none', color: '#DC3545', padding: '4px 8px' };
  return { ...base, border: '1.5px solid #2F5597', background: '#2F5597', color: 'white' };
}

const styles: Record<string, React.CSSProperties> = {
  main: { fontFamily: 'system-ui, sans-serif', padding: 'clamp(1rem, 4vw, 2rem)', maxWidth: 860, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' },
  title: { margin: 0, color: '#203864' },
  subtitle: { margin: '4px 0 0', color: '#6c6f76', fontSize: 13.5, maxWidth: 560 },
  section: { marginBottom: '2rem', background: 'white', borderRadius: 10, padding: '1.25rem 1.5rem', border: '1px solid #e4e6ea' },
  h2: { fontSize: 15, margin: '0 0 12px', color: '#203864' },
  inlineForm: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 4 },
  input: { padding: '7px 10px', borderRadius: 6, border: '1px solid #d0d4da', fontSize: 13 },
  dateLabel: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: '#6c6f76' },
  muted: { color: '#9aa0a8', fontSize: 13, margin: 0 },
  error: { color: '#DC3545', fontSize: 13 },
  row: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8,
    padding: '8px 10px', borderRadius: 8, background: '#f7f8fa', border: '1px solid #e4e6ea',
  },
  rowGroup: { display: 'flex', flexDirection: 'column', gap: 6 },
  historyBox: {
    display: 'flex', flexDirection: 'column', gap: 6, marginLeft: 16, padding: '10px 12px',
    borderRadius: 8, background: '#fbfbfc', border: '1px dashed #d0d4da',
  },
  historyRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8,
    padding: '6px 10px', borderRadius: 6, background: 'white', border: '1px solid #e4e6ea', fontSize: 13,
  },
  historyRowCurrent: { border: '1.5px solid #2F9E44', background: '#F1FBF3' },
  currentBadge: {
    marginLeft: 8, fontSize: 10.5, fontWeight: 700, color: '#2F9E44', background: '#E3F7E7',
    borderRadius: 4, padding: '1px 6px', verticalAlign: 'middle',
  },
  currentPriceInline: {
    marginLeft: 8, fontSize: 12.5, fontWeight: 700, color: '#2F9E44', background: '#E3F7E7',
    borderRadius: 4, padding: '1px 7px',
  },
  noPriceInline: {
    marginLeft: 8, fontSize: 11.5, fontStyle: 'italic', color: '#9aa0a8',
  },
};

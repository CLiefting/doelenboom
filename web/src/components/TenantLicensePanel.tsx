import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { ModuleDef, Tier, TenantLicense } from '../types';

// Licentie van één tenant: huidig tier (met gebruik tegen de limieten) en
// welke modules actief zijn — zie doelenboom_licentiemodel.md. Alleen
// zichtbaar/bruikbaar voor sysadmins (tier/modules toewijzen is een
// commerciële beslissing, geen zelfbedieningsactie voor een tenant-admin —
// zie routes/licenses.ts) — gebruikt binnen TenantManagementPage, dat zelf al
// bepaalt of de ingelogde gebruiker sysadmin is.
export default function TenantLicensePanel({ token, tenantId }: { token: string; tenantId: number }) {
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
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, tenantId]);

  async function changeTier(tierId: number | null) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.setTenantTier(token, tenantId, tierId);
      setLicense(updated);
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
      const updated = await api.setTenantModule(token, tenantId, moduleKey, active);
      setLicense(updated);
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
      const updated = await api.setTenantLicenseEndDate(token, tenantId, endDate);
      setLicense(updated);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  if (!license || !tiers || !modules) {
    return error ? <p style={styles.error}>{error}</p> : <p style={styles.muted}>Laden…</p>;
  }

  const activeModuleSet = new Set(license.activeModules);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {error && <p style={styles.error}>{error}</p>}

      {license.expired && (
        <p style={styles.expiredBanner}>
          Licentie verlopen{license.endDate ? ` op ${formatDateNL(license.endDate)}` : ''} — deze tenant staat
          nu op alleen-lezen voor iedereen behalve sysadmins.
        </p>
      )}

      <div>
        <label style={styles.label}>Einddatum</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="date"
            style={styles.dateInput}
            disabled={busy}
            value={license.endDate ?? ''}
            onChange={(e) => changeEndDate(e.target.value || null)}
          />
          {license.endDate && (
            <button
              type="button"
              disabled={busy}
              style={styles.clearBtn}
              onClick={() => changeEndDate(null)}
            >
              Wissen (nooit verlopen)
            </button>
          )}
        </div>
        <p style={styles.muted}>
          {license.endDate
            ? `Geldig t/m ${formatDateNL(license.endDate)}. Bij het aanmaken van een tenant wordt dit automatisch ` +
              `gezet op het einde van die maand + 12 maanden (jaarlicentie) — hier te verlengen of te wijzigen.`
            : 'Geen einddatum ingesteld — deze tenant verloopt nooit.'}
        </p>
      </div>

      <div>
        <label style={styles.label}>Tier</label>
        <select
          style={styles.select}
          disabled={busy}
          value={license.tier?.id ?? ''}
          onChange={(e) => changeTier(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">— geen licentie (onbeperkt) —</option>
          {tiers.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} (max {t.maxAdmins} admin{t.maxAdmins === 1 ? '' : 's'}, max {t.maxBomen} bomen)
            </option>
          ))}
        </select>
        <p style={styles.muted}>
          {license.tier
            ? `Gebruik: ${license.usage.activeAdmins}/${license.tier.maxAdmins} actieve admins, ` +
              `${license.usage.activeBomen}/${license.tier.maxBomen} actieve doelenbomen.`
            : `Geen tier ingesteld — geen limiet op aantal admins/doelenbomen.`}
          {' '}
          <span style={{ opacity: 0.75 }}>
            ({license.usage.lifetimeBomenAangemaakt} doelenb{license.usage.lifetimeBomenAangemaakt === 1 ? 'oom' : 'omen'}{' '}
            ooit aangemaakt in totaal, puur ter info.)
          </span>
        </p>
      </div>

      <div>
        <label style={styles.label}>Modules</label>
        {modules.length === 0 && <p style={styles.muted}>Nog geen modules in de catalogus.</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {modules.map((m) => (
            <label key={m.key} style={styles.moduleRow}>
              <input
                type="checkbox"
                disabled={busy}
                checked={activeModuleSet.has(m.key)}
                onChange={(e) => toggleModule(m.key, e.target.checked)}
              />
              <div>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{m.name}</div>
                {m.description && <div style={{ fontSize: 12, color: '#6c6f76' }}>{m.description}</div>}
              </div>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Er ging iets mis.';
}

// "YYYY-MM-DD" -> "dd-mm-jjjj" voor weergave. Geeft de ruwe waarde terug als
// die onverwacht niet dat formaat heeft, i.p.v. te crashen.
function formatDateNL(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return dateStr;
  const [, y, mo, d] = m;
  return `${d}-${mo}-${y}`;
}

const styles: Record<string, React.CSSProperties> = {
  label: { display: 'block', fontSize: 12.5, fontWeight: 600, color: '#6c6f76', marginBottom: 4 },
  select: { padding: '7px 10px', borderRadius: 6, border: '1px solid #d0d4da', fontSize: 13, width: '100%', maxWidth: 420 },
  moduleRow: {
    display: 'flex', gap: 10, alignItems: 'flex-start',
    padding: '8px 10px', borderRadius: 8, background: '#f7f8fa', border: '1px solid #e4e6ea', cursor: 'pointer',
  },
  muted: { color: '#9aa0a8', fontSize: 12.5, margin: '6px 0 0' },
  error: { color: '#DC3545', fontSize: 13 },
  expiredBanner: {
    color: '#7A1F1F', background: '#FBE8E8', border: '1px solid #F1C2C2',
    borderRadius: 8, padding: '9px 12px', fontSize: 13, margin: 0,
  },
  dateInput: { padding: '7px 10px', borderRadius: 6, border: '1px solid #d0d4da', fontSize: 13 },
  clearBtn: {
    padding: '6px 10px', borderRadius: 6, border: '1px solid #d0d4da', background: '#fff',
    fontSize: 12.5, cursor: 'pointer', color: '#4a4d54',
  },
};

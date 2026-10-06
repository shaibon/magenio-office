import { useTranslation } from 'react-i18next';
import { normalizeProviderQuota, type ProviderQuotaConfig, type QuotaProvider } from '@shared/providerQuota';

const inputStyle = {
  width: 64, fontSize: 12, padding: '2px 4px', background: 'var(--cth-cream-50)', color: 'var(--cth-ink-900)',
  border: 0, boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', fontFamily: 'var(--cth-font-mono)'
} as const;
const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 6 } as const;
const labelStyle = { fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' } as const;

/** Settings → Autonomy & Budgets: which provider quota chips show, their
 *  thresholds and the refresh interval. Edits are staged by the caller. */
export function ProviderQuotaSettings({ value, onChange }: {
  value: Partial<ProviderQuotaConfig> | undefined;
  onChange: (next: ProviderQuotaConfig) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const v = normalizeProviderQuota(value);
  const set = (patch: Partial<ProviderQuotaConfig>): void => onChange({ ...v, ...patch });
  // Typed values are only committed when they parse; normalize() repairs impossible pairs on save.
  const numInput = (key: 'yellow' | 'red' | 'balanceYellow' | 'balanceRed' | 'refreshMinutes', min: number): JSX.Element => (
    <input
      type="number" min={min} step={key.startsWith('balance') ? 0.5 : 1} value={v[key]} style={inputStyle}
      onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) set({ [key]: n } as Partial<ProviderQuotaConfig>); }}
    />
  );
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--cth-ink-500)', marginBottom: 4 }}>{t('settings.quota.desc')}</div>
      {(['claude', 'codex', 'deepseek'] as QuotaProvider[]).map((p) => (
        <label key={p} style={{ ...rowStyle, cursor: 'pointer' }}>
          <span style={labelStyle}>{t(`quota.provider.${p}`)}</span>
          <input type="checkbox" checked={v[p]} onChange={(e) => set({ [p]: e.target.checked } as Partial<ProviderQuotaConfig>)} />
        </label>
      ))}
      <div style={rowStyle}><span style={labelStyle}>{t('settings.quota.yellow')}</span>{numInput('yellow', 1)}</div>
      <div style={rowStyle}><span style={labelStyle}>{t('settings.quota.red')}</span>{numInput('red', 1)}</div>
      <div style={rowStyle}><span style={labelStyle}>{t('settings.quota.balanceYellow')}</span>{numInput('balanceYellow', 0)}</div>
      <div style={rowStyle}><span style={labelStyle}>{t('settings.quota.balanceRed')}</span>{numInput('balanceRed', 0)}</div>
      <div style={rowStyle}><span style={labelStyle}>{t('settings.quota.refresh')}</span>{numInput('refreshMinutes', 1)}</div>
    </div>
  );
}

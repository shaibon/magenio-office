import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  chipLabel, chipLevel, formatMoney, normalizeProviderQuota, windowLabel,
  type ProviderQuotaConfig, type QuotaChip, type QuotaLevel
} from '@shared/providerQuota';

const LEVEL_BG: Record<QuotaLevel, string> = {
  green: 'var(--cth-mint-light)', yellow: 'var(--cth-lemon-light)', red: 'var(--cth-coral-light)'
};

/** Plan-quota pills for the Command Center header, one per enabled provider.
 *  Click opens a detail popover. The renderer only ever sees percentages, reset
 *  times and balances — fetching and credentials stay in main. */
export function QuotaChips(): JSX.Element | null {
  const { t, i18n } = useTranslation();
  const [chips, setChips] = useState<QuotaChip[]>([]);
  const [cfg, setCfg] = useState<ProviderQuotaConfig>(() => normalizeProviderQuota(undefined));
  const [open, setOpen] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const loadCfg = (): void => {
      window.cth.getConfig().then((c) => { if (alive) setCfg(normalizeProviderQuota(c.providerQuota)); }).catch(() => { /* main not ready */ });
    };
    loadCfg();
    window.cth.quotaGet().then((c) => { if (alive) setChips(c); }).catch(() => { /* main not ready */ });
    // Config can change in Settings; thresholds are re-read whenever main pushes a refresh.
    const off = window.cth.onQuotaUpdate((c) => { setChips(c); loadCfg(); });
    return () => { alive = false; off(); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent): void => { if (!box.current?.contains(e.target as Node)) setOpen(null); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const shown = chips.filter((c) => cfg[c.provider]);
  if (shown.length === 0) return null;

  const when = (ms: number | null): string =>
    ms === null ? t('quota.noReset')
      : t('quota.resets', { when: new Date(ms).toLocaleString(i18n.language, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) });

  return (
    <div ref={box} style={{ display: 'flex', gap: 4, alignItems: 'center', position: 'relative' }}>
      {shown.map((c) => {
        const level = chipLevel(c, cfg);
        const tip = c.ok ? t('quota.tip') : t('quota.unavailable', { reason: c.reason ?? '' });
        return (
          <button
            key={c.provider}
            type="button"
            className="cth-tip cth-tip-wrap"
            data-tip={tip}
            aria-label={`${chipLabel(c)} — ${tip}`}
            aria-expanded={open === c.provider}
            onClick={() => setOpen(open === c.provider ? null : c.provider)}
            style={{
              background: c.ok ? LEVEL_BG[level] : 'var(--cth-cream-200)', color: 'var(--cth-ink-900)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', border: 0, padding: '2px 6px',
              fontSize: 11, lineHeight: '16px', whiteSpace: 'nowrap', cursor: 'pointer', fontFamily: 'inherit'
            }}
          >{chipLabel(c)}</button>
        );
      })}
      {open && (() => {
        const c = shown.find((x) => x.provider === open);
        if (!c) return null;
        return (
          <div role="dialog" style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 50, minWidth: 220,
            background: 'var(--cth-cream-50)', color: 'var(--cth-ink-900)', padding: 8, fontSize: 12, lineHeight: '18px',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-700), var(--cth-shadow-hard)'
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{t(`quota.provider.${c.provider}`)}</div>
            {!c.ok && <div>{t('quota.unavailable', { reason: c.reason ?? '' })}</div>}
            {c.ok && c.kind === 'percent' && (c.windows ?? []).map((w) => (
              <div key={w.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span>{windowLabel(w)}: {Math.round(w.usedPercent)}%</span>
                <span style={{ color: 'var(--cth-ink-500)' }}>{when(w.resetsAt)}</span>
              </div>
            ))}
            {c.ok && c.kind === 'balance' && (c.balances ?? []).map((b) => (
              <div key={b.currency}>
                <div>{t('quota.balanceTotal', { amount: formatMoney(b.total, b.currency) })}</div>
                <div style={{ color: 'var(--cth-ink-500)' }}>
                  {t('quota.balanceSplit', { bonus: formatMoney(b.granted, b.currency), topped: formatMoney(b.toppedUp, b.currency) })}
                </div>
                {c.spentToday?.[b.currency] !== undefined && (
                  <div>{t('quota.spentToday', { amount: formatMoney(c.spentToday[b.currency], b.currency) })}</div>
                )}
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

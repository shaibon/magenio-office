import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import {
  filterTempHistory, totalTempHistory,
  type TempFilter, type TempRange, type TempRow, type TempStatus
} from '@shared/tempHistory';

/** Temp History — read-only list of every ephemeral worker, past and present.
 *  Lives under the live workers in the Workers tab; data comes from main's
 *  `workers:history`, which folds the app's own records. */

const POLL_MS = 10_000;
const STATUSES: TempStatus[] = ['running', 'done', 'failed', 'killed', 'preserved-worktree'];
const RANGES: { key: TempRange; labelKey: string }[] = [
  { key: '24h', labelKey: 'tempHistory.range24h' },
  { key: '7d', labelKey: 'tempHistory.range7d' },
  { key: 'all', labelKey: 'tempHistory.rangeAll' }
];

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  if (m < 90) return `${m}m`;
  const h = m / 60;
  return h < 48 ? `${h.toFixed(1)}h` : `${Math.round(h / 24)}d`;
}

const card: React.CSSProperties = {
  background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4
};
const metaRow: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: '2px 14px', fontFamily: 'var(--cth-font-mono)',
  fontSize: 11, color: 'var(--cth-ink-700)'
};
const control: React.CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 11, padding: '2px 4px',
  background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)',
  border: '1px solid var(--cth-ink-100)'
};

export function TempHistory() {
  const { t } = useTranslation();
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const [rows, setRows] = useState<TempRow[]>([]);
  const [filter, setFilter] = useState<TempFilter>({ project: '', status: '', range: '7d' });

  useEffect(() => {
    let alive = true;
    const load = () => { window.cth.workerHistory().then((r) => { if (alive) setRows(r); }).catch(() => { /* main not ready */ }); };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const projects = useMemo(() => [...new Set(rows.map((r) => r.project).filter(Boolean))].sort(), [rows]);
  const shown = useMemo(() => filterTempHistory(rows, filter, Date.now()), [rows, filter]);
  const totals = useMemo(() => totalTempHistory(shown), [shown]);

  return (
    <div>
      <span style={{
        fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: 0.5, color: 'var(--cth-ink-900)'
      }}>{t('tempHistory.title')}</span>
      <p style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)', margin: '2px 0 8px' }}>
        {t('tempHistory.intro')}
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        <select aria-label={t('tempHistory.project')} style={control} value={filter.project}
          onChange={(e) => setFilter({ ...filter, project: e.target.value })}>
          <option value="">{t('tempHistory.allProjects')}</option>
          {projects.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select aria-label={t('tempHistory.status')} style={control} value={filter.status}
          onChange={(e) => setFilter({ ...filter, status: e.target.value as TempStatus | '' })}>
          <option value="">{t('tempHistory.allStatuses')}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`tempHistory.statuses.${s}`)}</option>)}
        </select>
        <select aria-label={t('tempHistory.started')} style={control} value={filter.range}
          onChange={(e) => setFilter({ ...filter, range: e.target.value as TempRange })}>
          {RANGES.map((r) => <option key={r.key} value={r.key}>{t(r.labelKey)}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {shown.length === 0 && (
          <div style={{ ...card, color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)', fontSize: 12 }}>
            {t('tempHistory.empty')}
          </div>
        )}
        {shown.map((r) => (
          <div key={r.workerId} style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
              <span style={{
                fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
              }} title={r.workerId}>{r.name}</span>
              <span style={{
                fontFamily: 'var(--cth-font-mono)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5,
                padding: '1px 6px', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', flexShrink: 0,
                color: r.status === 'failed' ? 'var(--cth-red, #b3261e)' : 'var(--cth-ink-900)'
              }}>{t(`tempHistory.statuses.${r.status}`)}</span>
            </div>
            {r.objective && (
              <div style={{
                fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
              }} title={r.objective}>{r.objective}</div>
            )}
            <div style={metaRow}>
              {(r.project || r.cwd) && <span style={{ wordBreak: 'break-all' }} title={r.cwd}>{r.project || r.cwd}</span>}
              <span>{t('tempHistory.started')} {new Date(r.startedAt).toLocaleString()}</span>
              {r.endedAt !== null && <span>→ {new Date(r.endedAt).toLocaleString()}</span>}
              <span>{t('tempHistory.duration')} {fmtDuration(r.durationMs)}</span>
              <span>{t('tempHistory.tokens')} {fmtTokens(r.tokens)}</span>
              <span>{t('tempHistory.cost')} ${r.usd.toFixed(2)}</span>
              {r.taskId && (
                <button onClick={() => openTaskDetail(r.taskId as string)} style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                  font: 'inherit', color: 'var(--cth-ink-900)', textDecoration: 'underline'
                }}>{t('tempHistory.card')} {r.taskId}</button>
              )}
            </div>
          </div>
        ))}
        {shown.length > 0 && (
          <div style={{ ...metaRow, justifyContent: 'flex-end', fontWeight: 700, color: 'var(--cth-ink-900)' }}>
            <span>{t('tempHistory.totals', { count: totals.count })}</span>
            <span>{t('tempHistory.tokens')} {fmtTokens(totals.tokens)}</span>
            <span>{t('tempHistory.cost')} ${totals.usd.toFixed(2)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

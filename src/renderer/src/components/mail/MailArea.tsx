import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from '../PixelButton';
import { Icon } from '../Icon';
import { jiraProjectsClient } from '@/jiraProjects/jiraProjectsClient';
import {
  ageLabel, countLabel, mailCounts, mergePage, nextCursor, pageMayHaveMore, selectMessages, triageReason,
  MAIL_PAGE_SIZE, type MailSelection
} from '@shared/mailView';

/** Email area (phase 1, read-only): accounts + per-project counts on the left, the
 *  triaged list in the middle, one sanitized message on the right. There is no
 *  send, reply or ticket action here — the only write is routing a message to a
 *  project. Bodies are shown as plain text; React escapes them. */

type Summary = Awaited<ReturnType<typeof window.cth.mailMessages>>[number];
type Detail = NonNullable<Awaited<ReturnType<typeof window.cth.mailMessage>>>;
type Account = Awaited<ReturnType<typeof window.cth.mailAccounts>>[number];

const POLL_MS = 60_000;
const col: React.CSSProperties = { display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' };
const small: React.CSSProperties = { fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)' };
const head: React.CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: 0.5, color: 'var(--cth-ink-900)', margin: '2px 0'
};

function Badge({ children, tone }: { children: React.ReactNode; tone?: 'alert' }) {
  return (
    <span style={{
      fontFamily: 'var(--cth-font-mono)', fontSize: 10, padding: '0 5px', textTransform: 'uppercase',
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', flexShrink: 0,
      color: tone === 'alert' ? 'var(--cth-red, #b3261e)' : 'var(--cth-ink-900)'
    }}>{children}</span>
  );
}

export function MailArea({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [msgs, setMsgs] = useState<Summary[]>([]);
  const [sel, setSel] = useState<MailSelection>({ kind: 'all' });
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const [polling, setPolling] = useState(false);
  // True while the server may hold mail older than what is loaded; counts then read "N+".
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const pages = useRef(1);

  const load = useCallback(() => {
    window.cth.mailAccounts().then(setAccounts).catch(() => { /* main not ready */ });
    // A refresh re-reads the newest page and merges it, so older pages already
    // loaded stay; only while nothing older is loaded does it decide `hasMore`.
    window.cth.mailMessages({ limit: MAIL_PAGE_SIZE }).then((page) => {
      setMsgs((prev) => mergePage(prev, page));
      if (pages.current === 1) setHasMore(pageMayHaveMore(page));
    }).catch(() => { /* main not ready */ });
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    jiraProjectsClient.list().then((l) => setProjects(l.map((b) => b.key))).catch(() => { /* no bindings */ });
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (openId === null) { setDetail(null); return; }
    let alive = true;
    window.cth.mailMessage(openId).then((d) => { if (alive) setDetail(d); }).catch(() => { /* gone */ });
    return () => { alive = false; };
  }, [openId, msgs]);

  const counts = useMemo(() => mailCounts(msgs), [msgs]);
  const shown = useMemo(() => selectMessages(msgs, sel), [msgs, sel]);
  const now = Date.now();

  const pollNow = async () => {
    setPolling(true);
    try { await window.cth.mailPollNow(); } finally { setPolling(false); load(); }
  };
  const loadMore = async () => {
    const before = nextCursor(msgs);
    if (before === undefined || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await window.cth.mailMessages({ limit: MAIL_PAGE_SIZE, before });
      pages.current += 1;
      setMsgs((prev) => mergePage(prev, page));
      setHasMore(pageMayHaveMore(page));
    } catch { /* main not ready */ } finally { setLoadingMore(false); }
  };
  const assign = async (id: number, key: string) => {
    const res = await window.cth.mailAssign(id, key || null);
    if (res.ok) load();
  };

  const selBtn = (active: boolean): React.CSSProperties => ({
    display: 'flex', justifyContent: 'space-between', width: '100%', textAlign: 'start',
    padding: '4px 8px', border: 'none', cursor: 'pointer', fontFamily: 'var(--cth-font-ui)', fontSize: 12,
    background: active ? 'var(--cth-cream-300)' : 'transparent', color: 'var(--cth-ink-900)'
  });
  const isSel = (s: MailSelection) => JSON.stringify(s) === JSON.stringify(sel);
  const catLabel = (c: string) => t(`mail.category.${c}`, { defaultValue: c });
  const urgLabel = (u: string) => t(`mail.urgency.${u}`, { defaultValue: u });

  return (
    <div role="dialog" aria-label={t('mail.title')} style={{
      position: 'fixed', inset: 0, zIndex: 280, display: 'flex', flexDirection: 'column',
      background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)'
    }}>
      <div className="cth-titlebar-nodrag" style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
        borderBottom: '2px solid var(--cth-ink-300)'
      }}>
        <span style={{ ...head, fontSize: 14 }}>{t('mail.title')}</span>
        <span style={small}>{t('mail.readOnly')}</span>
        <PixelButton onClick={pollNow} disabled={polling || accounts.length === 0}>
          {polling ? t('mail.polling') : t('mail.pollNow')}
        </PixelButton>
        <button onClick={onClose} title={t('mail.close')} aria-label={t('mail.close')} style={{
          marginInlineStart: 'auto', width: 28, height: 28, padding: 0, cursor: 'pointer',
          background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
          border: 'none', color: 'var(--cth-ink-900)'
        }}><Icon name="x" size={1} style={{ width: 16, height: 16 }} /></button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '220px minmax(260px, 1fr) minmax(300px, 1.2fr)' }}>
        {/* Left: accounts, buckets */}
        <div style={{ ...col, padding: 10, gap: 10, borderInlineEnd: '1px solid var(--cth-ink-100)' }}>
          <div>
            <div style={head}>{t('mail.accounts')}</div>
            {accounts.length === 0 && <div style={small}>{t('mail.noAccounts')}</div>}
            {accounts.map((a) => (
              <div key={a.id} style={{ ...small, display: 'flex', gap: 6, alignItems: 'baseline' }} title={a.lastError ?? ''}>
                <span style={{ color: a.status === 'ok' ? 'var(--cth-green, #2f8f4e)' : 'var(--cth-red, #b3261e)' }}>●</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.address}</span>
                <span>{a.status === 'ok' ? t('mail.ok') : t('mail.error')}</span>
              </div>
            ))}
            {accounts.some((a) => a.status === 'error' && a.lastError) && (
              <div style={{ ...small, color: 'var(--cth-red, #b3261e)', marginTop: 4 }}>
                {accounts.find((a) => a.status === 'error')?.lastError}
              </div>
            )}
          </div>
          <div>
            <div style={head}>{t('mail.projects')}</div>
            {hasMore && <div style={small}>{t('mail.loadedOnly', { count: msgs.length })}</div>}
            <button style={selBtn(isSel({ kind: 'all' }))} onClick={() => setSel({ kind: 'all' })}>
              <span>{t('mail.all')}</span><span>{countLabel(counts.total, hasMore)}</span>
            </button>
            {counts.byProject.map(([key, n]) => (
              <button key={key} style={selBtn(isSel({ kind: 'project', key }))} onClick={() => setSel({ kind: 'project', key })}>
                <span>{key}</span><span>{countLabel(n, hasMore)}</span>
              </button>
            ))}
            <button style={selBtn(isSel({ kind: 'unassigned' }))} onClick={() => setSel({ kind: 'unassigned' })}>
              <span>{t('mail.unassigned')}</span><span>{countLabel(counts.unassigned, hasMore)}</span>
            </button>
          </div>
        </div>

        {/* Centre: triaged list */}
        <div style={{ ...col, borderInlineEnd: '1px solid var(--cth-ink-100)' }}>
          {shown.length === 0 && <div style={{ ...small, padding: 14 }}>{t('mail.empty')}</div>}
          {shown.map((m) => (
            <button key={m.id} onClick={() => setOpenId(m.id)} style={{
              display: 'flex', flexDirection: 'column', gap: 3, textAlign: 'start', padding: '8px 12px',
              border: 'none', borderBottom: '1px solid var(--cth-ink-100)', cursor: 'pointer',
              background: openId === m.id ? 'var(--cth-cream-300)' : 'transparent', color: 'var(--cth-ink-900)'
            }}>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Badge>{m.triage?.projectKey ?? t('mail.unassignedShort')}</Badge>
                {m.triage && <Badge>{catLabel(m.triage.category)}</Badge>}
                {m.triage?.urgency === 'high' && <Badge tone="alert">{urgLabel('high')}</Badge>}
                <span style={{ ...small, marginInlineStart: 'auto' }}>{ageLabel(m.receivedAt, now)}</span>
              </span>
              <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.subject || t('mail.noSubject')}
              </span>
              <span style={{ ...small, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.fromName || m.fromAddr}
              </span>
            </button>
          ))}
          {hasMore && (
            <div style={{ padding: 10 }}>
              <PixelButton onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? t('mail.loadingMore') : t('mail.loadMore')}
              </PixelButton>
            </div>
          )}
        </div>

        {/* Right: detail */}
        <div style={{ ...col, padding: 14, gap: 10 }}>
          {!detail && <div style={small}>{t('mail.selectOne')}</div>}
          {detail && (() => {
            const reason = triageReason(detail.triage);
            return (
              <>
                <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 14, fontWeight: 700 }}>{detail.subject || t('mail.noSubject')}</div>
                <div style={small}>
                  {detail.fromName ? `${detail.fromName} <${detail.fromAddr}>` : detail.fromAddr}
                  {' · '}{new Date(detail.receivedAt).toLocaleString()}
                </div>
                <div style={small}>{t('mail.to')}: {detail.to.join(', ')}</div>

                <div style={{ padding: 8, boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={head}>{t('mail.triage')}</div>
                  {detail.triage ? (
                    <>
                      <div style={small}>
                        {catLabel(detail.triage.category)} · {urgLabel(detail.triage.urgency)}
                        {' · '}{detail.triage.projectKey ?? t('mail.unassigned')}
                        {detail.triage.needsReply ? ` · ${t('mail.needsReply')}` : ''}
                      </div>
                      <div style={small}>{t(reason.key, { pct: reason.pct })}</div>
                      {detail.triage.summary && <div style={{ ...small, color: 'var(--cth-ink-900)' }}>{detail.triage.summary}</div>}
                    </>
                  ) : <div style={small}>{t(reason.key)}</div>}
                  <label style={{ ...small, display: 'flex', gap: 6, alignItems: 'center' }}>
                    {t('mail.assignTo')}
                    <select value={detail.triage?.projectKey ?? ''} onChange={(e) => assign(detail.id, e.target.value)} style={{
                      fontSize: 11, padding: '2px 4px', background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)',
                      border: '1px solid var(--cth-ink-100)'
                    }}>
                      <option value="">{t('mail.unassigned')}</option>
                      {[...new Set([...projects, ...(detail.triage?.projectKey ? [detail.triage.projectKey] : [])])].map((p) => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </label>
                </div>

                {detail.attachments.length > 0 && (
                  <div style={small}>
                    {t('mail.attachments')}: {detail.attachments.map((a) => `${a.filename} (${Math.ceil(a.size / 1024)} KB)`).join(', ')}
                  </div>
                )}
                {detail.bodyText === null
                  ? <div style={small}>{t('mail.bodyPurged')}</div>
                  : <pre style={{
                    margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    fontFamily: 'var(--cth-font-mono)', fontSize: 12, color: 'var(--cth-ink-900)'
                  }}>{detail.bodyText}</pre>}
              </>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

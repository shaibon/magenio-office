import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from '../PixelButton';
import { jiraProjectsClient } from '@/jiraProjects/jiraProjectsClient';
import { validateMailAccountInput, DEFAULT_MAIL_AGENT, type MailAgentSettings, type MailAgentStatus, type MailRuleKind } from '@shared/mail';
import { OSS_LOCAL_PICKS } from '@shared/ossModels';
import { agentBadge, agentFormIssue } from '@shared/mailView';

/** Settings → Email: the IMAP account (password is write-only — main never sends it
 *  back, and an empty field on edit keeps the stored one), polling / retention, and
 *  the sender → project rules. TLS is not an option; the backend always verifies. */

type Account = Awaited<ReturnType<typeof window.cth.mailAccounts>>[number];
type Rule = Awaited<ReturnType<typeof window.cth.mailRules>>[number];

const RULE_KINDS: MailRuleKind[] = ['fromAddr', 'fromDomain', 'keyword'];
const label: React.CSSProperties = { fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 700, color: 'var(--cth-ink-900)' };
const sub: React.CSSProperties = { fontSize: 11, color: 'var(--cth-ink-500)' };
const input: React.CSSProperties = {
  fontSize: 12, padding: '3px 6px', background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)',
  border: '1px solid var(--cth-ink-100)', minWidth: 0
};
const row: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' };
const box: React.CSSProperties = { padding: 8, boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', display: 'flex', flexDirection: 'column', gap: 6 };

const EMPTY = { id: undefined as string | undefined, address: '', host: '', port: '993', username: '', mailbox: 'INBOX', password: '' };

/** Settings → Email → Mail agent: the LOCAL model that summarises mail. Loopback
 *  endpoint only (checked here for a clear message, and again in main on every call). */
function MailAgentBlock() {
  const { t } = useTranslation();
  const [form, setForm] = useState<MailAgentSettings>(DEFAULT_MAIL_AGENT);
  const [status, setStatus] = useState<MailAgentStatus | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.cth.mailAgentGet().then((r) => { setForm(r.settings); setStatus(r.status); }).catch(() => { /* main not ready */ });
  }, []);

  const issue = agentFormIssue(form);
  const apply = async (next: MailAgentSettings) => {
    setForm(next);
    if (agentFormIssue(next)) return; // shown inline; nothing is saved until it is valid
    const res = await window.cth.mailAgentSet(next);
    setStatus(res.status);
    if (res.ok) { setForm(res.settings); setErr(''); } else setErr(res.error || t('mailSettings.couldNotSave'));
  };
  const test = async () => { setBusy(true); try { setStatus(await window.cth.mailAgentTest()); } finally { setBusy(false); } };
  const badge = agentBadge(status);

  return (
    <div style={box}>
      <div style={label}>{t('mail.agent.title')}</div>
      <span style={sub}>{t('mail.agent.privacy')}</span>
      <label style={{ ...row, fontSize: 12 }}>
        <input type="checkbox" checked={form.enabled} onChange={(e) => void apply({ ...form, enabled: e.target.checked })} />
        {t('mail.agent.enable')}
      </label>
      <div style={row}>
        <input style={{ ...input, flex: 2 }} aria-label={t('mail.agent.endpoint')} placeholder={t('mail.agent.endpoint')} value={form.baseUrl}
          onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} onBlur={() => void apply(form)} />
        <input style={{ ...input, flex: 1 }} list="mail-agent-models" aria-label={t('mail.agent.model')} placeholder={t('mail.agent.model')} value={form.model}
          onChange={(e) => setForm({ ...form, model: e.target.value })} onBlur={() => void apply(form)} />
        <datalist id="mail-agent-models">
          {OSS_LOCAL_PICKS.map((p) => <option key={p.tag} value={p.tag}>{p.label} · {p.minRam}</option>)}
        </datalist>
      </div>
      {issue && <span role="alert" style={{ fontSize: 12, color: 'var(--cth-red, #b3261e)' }}>{t(`mail.agent.issue.${issue}`)}</span>}
      {err && !issue && <span role="alert" style={{ fontSize: 12, color: 'var(--cth-red, #b3261e)' }}>{err}</span>}
      <div style={row}>
        <PixelButton onClick={test} disabled={busy || !!issue || !form.model.trim()}>
          {busy ? t('mail.agent.testing') : t('mail.agent.test')}
        </PixelButton>
        <span style={{ fontSize: 12 }}>
          <b>{t(badge.key)}</b>{status?.detail ? ` — ${status.detail}` : ''}
        </span>
      </div>
    </div>
  );
}

export function MailSettings() {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [form, setForm] = useState<typeof EMPTY | null>(null);
  const [err, setErr] = useState('');
  const [pollMinutes, setPollMinutes] = useState('5');
  const [retentionDays, setRetentionDays] = useState('30');
  const [newRule, setNewRule] = useState({ kind: 'fromDomain' as MailRuleKind, pattern: '', projectKey: '' });

  const refresh = useCallback(() => {
    window.cth.mailAccounts().then(setAccounts).catch(() => { /* main not ready */ });
    window.cth.mailRules().then(setRules).catch(() => { /* main not ready */ });
  }, []);

  useEffect(() => {
    refresh();
    window.cth.mailSettings().then((s) => { setPollMinutes(String(s.pollMinutes)); setRetentionDays(String(s.retentionDays)); }).catch(() => { /* defaults */ });
    jiraProjectsClient.list().then((l) => setProjects(l.map((b) => b.key))).catch(() => { /* no bindings */ });
  }, [refresh]);

  const saveAccount = async () => {
    if (!form) return;
    const input = {
      id: form.id, address: form.address, host: form.host, port: Number(form.port),
      username: form.username, mailbox: form.mailbox || 'INBOX', password: form.password || undefined
    };
    // The same validator main runs; a password is only mandatory on create.
    const v = validateMailAccountInput(input);
    if (!v.ok) { setErr(v.error); return; }
    if (!form.id && !form.password) { setErr(t('mailSettings.passwordRequired')); return; }
    const res = await window.cth.mailAccountSave(input);
    if (!res.ok) { setErr(res.error || t('mailSettings.couldNotSave')); return; }
    setErr(''); setForm(null); refresh();
  };

  const saveNumber = (key: 'mailPollMinutes' | 'mailRetentionDays', raw: string, min: number) => {
    const n = Math.floor(Number(raw));
    if (Number.isFinite(n) && n >= min) void window.cth.updateConfig({ [key]: n });
  };

  const addRule = async () => {
    if (!newRule.pattern.trim() || !newRule.projectKey.trim()) return;
    const res = await window.cth.mailRuleSave({ ...newRule, enabled: true });
    if (res.ok) { setNewRule({ ...newRule, pattern: '' }); setErr(''); refresh(); } else setErr(res.error || t('mailSettings.couldNotSave'));
  };

  const f = (k: keyof typeof EMPTY) => ({
    value: form?.[k] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((p) => (p ? { ...p, [k]: e.target.value } : p))
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={label}>{t('mailSettings.title')}</div>
        <div style={sub}>{t('mailSettings.desc')}</div>
      </div>

      <div style={box}>
        {accounts.length === 0 && <span style={sub}>{t('mail.noAccounts')}</span>}
        {accounts.map((a) => (
          <div key={a.id} style={{ ...row, justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12 }}>
              {a.address} <span style={sub}>{a.host}:{a.port} · {a.mailbox} · {a.status === 'ok' ? t('mail.ok') : t('mail.error')}</span>
            </span>
            <span style={row}>
              <PixelButton onClick={() => { setErr(''); setForm({ id: a.id, address: a.address, host: a.host, port: String(a.port), username: a.username, mailbox: a.mailbox, password: '' }); }}>
                {t('mailSettings.edit')}
              </PixelButton>
              <PixelButton onClick={async () => { await window.cth.mailAccountRemove(a.id); refresh(); }}>{t('mailSettings.remove')}</PixelButton>
            </span>
          </div>
        ))}
        {!form && <div><PixelButton onClick={() => { setErr(''); setForm({ ...EMPTY }); }}>{t('mailSettings.addAccount')}</PixelButton></div>}
      </div>

      {form && (
        <div style={box}>
          <div style={row}>
            <input style={{ ...input, flex: 1 }} placeholder={t('mailSettings.address')} aria-label={t('mailSettings.address')} {...f('address')} />
            <input style={{ ...input, flex: 1 }} placeholder={t('mailSettings.host')} aria-label={t('mailSettings.host')} {...f('host')} />
            <input style={{ ...input, width: 64 }} placeholder={t('mailSettings.port')} aria-label={t('mailSettings.port')} inputMode="numeric" {...f('port')} />
          </div>
          <div style={row}>
            <input style={{ ...input, flex: 1 }} placeholder={t('mailSettings.username')} aria-label={t('mailSettings.username')} autoComplete="off" {...f('username')} />
            <input style={{ ...input, width: 110 }} placeholder={t('mailSettings.mailbox')} aria-label={t('mailSettings.mailbox')} {...f('mailbox')} />
            <input
              style={{ ...input, flex: 1 }} type="password" autoComplete="new-password"
              placeholder={form.id ? t('mailSettings.passwordKeep') : t('mailSettings.password')}
              aria-label={t('mailSettings.password')} {...f('password')}
            />
          </div>
          <span style={sub}>{t('mailSettings.passwordNote')}</span>
          <div style={row}>
            <PixelButton onClick={saveAccount}>{t('mailSettings.save')}</PixelButton>
            <PixelButton variant="secondary" onClick={() => { setForm(null); setErr(''); }}>{t('mailSettings.cancel')}</PixelButton>
          </div>
        </div>
      )}
      {err && <span role="alert" style={{ fontSize: 12, color: 'var(--cth-red, #b3261e)' }}>{err}</span>}

      <div style={row}>
        <label style={{ ...sub, display: 'flex', gap: 6, alignItems: 'center' }}>
          {t('mailSettings.pollMinutes')}
          <input style={{ ...input, width: 56 }} inputMode="numeric" value={pollMinutes}
            onChange={(e) => setPollMinutes(e.target.value)} onBlur={() => saveNumber('mailPollMinutes', pollMinutes, 1)} />
        </label>
        <label style={{ ...sub, display: 'flex', gap: 6, alignItems: 'center' }}>
          {t('mailSettings.retentionDays')}
          <input style={{ ...input, width: 56 }} inputMode="numeric" value={retentionDays}
            onChange={(e) => setRetentionDays(e.target.value)} onBlur={() => saveNumber('mailRetentionDays', retentionDays, 0)} />
        </label>
        <span style={sub}>{t('mailSettings.retentionNote')}</span>
      </div>

      <MailAgentBlock />

      <div style={box}>
        <div style={label}>{t('mailSettings.rules')}</div>
        <span style={sub}>{t('mailSettings.rulesDesc')}</span>
        {rules.map((r) => (
          <div key={r.id} style={{ ...row, justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, opacity: r.enabled ? 1 : 0.5 }}>
              {t(`mailSettings.kind.${r.kind}`)}: <b>{r.pattern}</b> → {r.projectKey}
            </span>
            <span style={row}>
              <PixelButton variant="secondary" onClick={async () => { await window.cth.mailRuleSave({ ...r, enabled: !r.enabled }); refresh(); }}>
                {r.enabled ? t('mailSettings.disable') : t('mailSettings.enable')}
              </PixelButton>
              <PixelButton onClick={async () => { await window.cth.mailRuleDelete(r.id); refresh(); }}>{t('mailSettings.remove')}</PixelButton>
            </span>
          </div>
        ))}
        <div style={row}>
          <select style={input} aria-label={t('mailSettings.ruleKind')} value={newRule.kind}
            onChange={(e) => setNewRule({ ...newRule, kind: e.target.value as MailRuleKind })}>
            {RULE_KINDS.map((k) => <option key={k} value={k}>{t(`mailSettings.kind.${k}`)}</option>)}
          </select>
          <input style={{ ...input, flex: 1 }} placeholder={t('mailSettings.pattern')} aria-label={t('mailSettings.pattern')}
            value={newRule.pattern} onChange={(e) => setNewRule({ ...newRule, pattern: e.target.value })} />
          <input style={{ ...input, width: 110 }} list="mail-rule-projects" placeholder={t('mailSettings.project')} aria-label={t('mailSettings.project')}
            value={newRule.projectKey} onChange={(e) => setNewRule({ ...newRule, projectKey: e.target.value })} />
          <datalist id="mail-rule-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
          <PixelButton onClick={addRule}>{t('mailSettings.addRule')}</PixelButton>
        </div>
      </div>
    </div>
  );
}

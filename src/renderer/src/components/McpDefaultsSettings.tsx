import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { jiraProjectsClient } from '@/jiraProjects/jiraProjectsClient';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import { MCP_CATALOG, createConsentWriter, n8nProjectOps, removeN8nProjectFlow, normalizeRemoteUrl, isN8nProjectKey, type McpTier, type N8nProjectEntry } from '@shared/mcpCatalog';
import { canInstallMcp } from './mcpInstallRule';

export interface McpDefaultsSettingsProps {
  config: HarnessConfig;
}

const TIER_ORDER: McpTier[] = ['safe-readonly', 'write', 'secret'];
const TIER_LABEL_KEY: Record<McpTier, string> = {
  'safe-readonly': 'mcpDefaults.tiers.safeReadonly',
  'write': 'mcpDefaults.tiers.write',
  'secret': 'mcpDefaults.tiers.secret'
};
const TIER_NOTE_KEY: Record<McpTier, string> = {
  'safe-readonly': 'mcpDefaults.tiers.safeReadonlyNote',
  'write': 'mcpDefaults.tiers.writeNote',
  'secret': 'mcpDefaults.tiers.secretNote'
};

const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-display)',
  fontSize: 8,
  lineHeight: '12px',
  color: 'var(--cth-ink-500)',
  textTransform: 'uppercase'
};

interface ConsentFieldProps {
  value: string;
  onCommit: (value: string) => void;
  multiline?: boolean;
  rows?: number;
  /** Shown while the field is empty. Carries a REAL example of the value the
   *  field wants: the hint below explains, the placeholder shows. */
  placeholder?: string;
  style: React.CSSProperties;
}

/**
 * A blur-to-save text field for MCP consent (command / args / agents).
 *
 * Genuinely controlled: `draft` is local state seeded from `value` and kept
 * in sync with it by the effect below. An earlier implementation used an
 * uncontrolled `<input defaultValue=.../>`: React applies `defaultValue`
 * only at mount, so once `onInstall` wrote a real command/args into
 * consent, the field kept showing the stale (usually blank) text it
 * mounted with — and an ordinary blur (click in, click out, type nothing)
 * would then write that stale text back over the value the install just
 * saved.
 *
 * The resync effect skips while the field is focused (`focusedRef`), so an
 * external value change (another save landing) never clobbers text the
 * user is actively typing. That suppression reopens the same hole on a
 * timing overlap, though: focus the field, let a write land elsewhere
 * (e.g. Install) while focused, then blur without typing — the resync was
 * skipped, so `draft` is still the old value, and committing it on blur
 * would silently overwrite what the write just stored.
 *
 * `editedRef` closes that hole: it is set only by `onChange`, i.e. only
 * when the user actually typed. On blur, a commit fires *only* if
 * `editedRef.current` is true — the user's own edit is the sole thing that
 * can ever be written. If the user never edited, blur instead re-seeds
 * `draft` from the current `value` (a plain re-sync, not a write), so the
 * field catches up to whatever landed while it was focused. That makes the
 * class of bug impossible regardless of timing: nothing this component
 * writes was not typed by the user.
 */
function ConsentField({ value, onCommit, multiline, rows, placeholder, style }: ConsentFieldProps) {
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  const editedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    editedRef.current = true;
    setDraft(e.target.value);
  };
  const handleFocus = () => { focusedRef.current = true; };
  const handleBlur = () => {
    focusedRef.current = false;
    if (editedRef.current) {
      editedRef.current = false;
      onCommit(draft);
    } else {
      // The user never typed, so there is nothing of theirs to commit.
      // The resync effect may have been suppressed for this field's whole
      // focused span (see above), so `draft` can be behind `value` even
      // though nothing was edited — catch it up here instead of writing.
      setDraft(value);
    }
  };

  return multiline ? (
    <textarea rows={rows} value={draft} onChange={handleChange} onFocus={handleFocus} onBlur={handleBlur} placeholder={placeholder} style={style} />
  ) : (
    <input value={draft} onChange={handleChange} onFocus={handleFocus} onBlur={handleBlur} placeholder={placeholder} style={style} />
  );
}

/** Multiselect of the ACTIVE agents of one project (agent.project === project). Saved ids that
 *  are no longer active stay listed so they can still be unticked. Disabled until a project is picked. */
function N8nAgentPicker({ project, value, onChange }: { project: string; value: string[]; onChange: (ids: string[]) => void }) {
  const { t } = useTranslation();
  const live = useStore((s) => s.agents);
  const options = project ? live.filter((a) => a.project === project).map((a) => ({ id: a.id, label: `${a.name} · ${a.id}` })) : [];
  const known = new Set(options.map((o) => o.id));
  const rows = [...options, ...value.filter((id) => !known.has(id)).map((id) => ({ id, label: id }))];
  return (
    <div role="group" aria-label={t('mcpDefaults.agents')} style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 8px', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', opacity: project ? 1 : 0.5 }}>
      {rows.length === 0 && <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{project ? t('mcpDefaults.n8nAgentsNone') : t('mcpDefaults.n8nAgentsPickProjectFirst')}</span>}
      {rows.map((r) => (
        <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--cth-ink-900)' }}>
          <input type="checkbox" disabled={!project} checked={value.includes(r.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, r.id] : value.filter((x) => x !== r.id))} />
          {r.label}
        </label>
      ))}
    </div>
  );
}

/** Fake, non-submittable value shown when a token is stored; leaving it untouched never writes. */
const N8N_TOKEN_MASK = '•••';

export function McpDefaultsSettings({ config }: McpDefaultsSettingsProps) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');

  const enabledFor = (id: string): boolean =>
    config.mcpDefaults?.[id]?.enabled ?? MCP_CATALOG.find((e) => e.id === id)?.defaultEnabled ?? false;

  // The most recently known `mcpDefaults`, used as the merge base for a new
  // write instead of the `config` prop. Two writes fired back-to-back (e.g.
  // tabbing from the command field to the args field) both happen before the
  // first `updateConfig` round-trip refreshes `config`, so merging against
  // the prop would make the second write silently revert the first. This
  // ref is updated synchronously, before either write's first `await`, so
  // the second write always merges on top of the first.
  const mcpDefaultsRef = useRef(config.mcpDefaults);
  useEffect(() => {
    mcpDefaultsRef.current = config.mcpDefaults;
  }, [config.mcpDefaults]);

  // Merges each patch against the latest known state (`mcpDefaultsRef`), serializes the
  // `updateConfig` calls and restores the ref when one is rejected. See createConsentWriter.
  const writeConsentPatch = useRef(
    createConsentWriter(mcpDefaultsRef, (next) => window.cth.updateConfig({ mcpDefaults: next }))
  ).current;

  const toggle = async (id: string) => {
    const next = !enabledFor(id);
    try {
      await writeConsentPatch(id, { enabled: next });
      setNote(t('mcpDefaults.toggleNote', { id, state: next ? t('common.on') : t('common.off') }));
      setTimeout(() => setNote(''), 1800);
    } catch {
      setNote(t('mcpDefaults.couldNotSave'));
      setTimeout(() => setNote(''), 2000);
    }
  };

  // `installDest` is main's own derivation of where an install would clone to.
  // It is DISPLAYED only: this component never constructs a path and never
  // sends one back — `mcpInstall` takes an id and nothing else.
  const [presence, setPresence] = useState<Record<string, { ok: boolean; reason?: string; detail?: string; installDest?: string }>>({});
  const [installing, setInstalling] = useState<string | null>(null);

  /** Re-run the preflight for every user-configured entry. Cheap (a few stat
   *  calls in main) and re-run after each save, because every field the user
   *  edits here is an input to it. */
  const refreshPresence = async () => {
    const configured = MCP_CATALOG.filter((e) => e.userConfigured);
    const results = await Promise.all(configured.map((e) => window.cth.mcpPresence(e.id)));
    setPresence(Object.fromEntries(configured.map((e, i) => [e.id, results[i]])));
  };

  useEffect(() => { void refreshPresence(); }, []);

  /** Merge a partial consent for one entry and re-run its preflight. */
  const patchConsent = async (id: string, p: { command?: string; args?: string[]; agents?: string[]; url?: string; projects?: Record<string, N8nProjectEntry> }) => {
    try {
      await writeConsentPatch(id, p);
      await refreshPresence();
    } catch {
      setNote(t('mcpDefaults.couldNotSave'));
      setTimeout(() => setNote(''), 2000);
    }
  };

  // Remote settings are keyed by both server id and project, so n8n and Team AI
  // can use the same project key without sharing a token badge or open row.
  const remoteProjects = (id: string) => config.mcpDefaults?.[id]?.projects ?? {};
  const remoteKey = (id: string, project: string) => `${id}:${project}`;
  const remoteRows = MCP_CATALOG.filter((e) => e.remote).flatMap((e) =>
    Object.keys(remoteProjects(e.id)).sort().map((project) => [e.id, project] as const));
  const remoteRowsKey = remoteRows.map(([id, project]) => remoteKey(id, project)).join('\n');
  const [remoteHasToken, setRemoteHasToken] = useState<Record<string, boolean>>({});
  const [remoteNewProject, setRemoteNewProject] = useState<Record<string, string>>({});
  const [remoteNewAgents, setRemoteNewAgents] = useState<Record<string, string[]>>({});
  const [remoteOpen, setRemoteOpen] = useState<Record<string, boolean>>({});
  const liveAgents = useStore((s) => s.agents);
  const [jiraKeys, setJiraKeys] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    jiraProjectsClient.list().then((l) => { if (alive) setJiraKeys(l.map((b) => b.key)); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  const remoteProjectChoices = (id: string) => [...new Set([...jiraKeys, ...liveAgents.map((a) => a.project ?? '')])]
    .filter((k) => isN8nProjectKey(k) && !Object.prototype.hasOwnProperty.call(remoteProjects(id), k)).sort();
  type TokenCheck = 'missing' | 'valid' | 'invalid' | 'unreachable' | 'checking';
  const [remoteCheck, setRemoteCheck] = useState<Record<string, TokenCheck>>({});
  const checkSeq = useRef<Record<string, number>>({});
  const setCheck = (id: string, project: string, value: TokenCheck) => {
    const key = remoteKey(id, project);
    checkSeq.current[key] = (checkSeq.current[key] ?? 0) + 1;
    setRemoteCheck((c) => ({ ...c, [key]: value }));
  };
  const checkRemoteToken = (id: string, project: string) => {
    const key = remoteKey(id, project);
    setCheck(id, project, 'checking');
    const mine = checkSeq.current[key];
    const land = (value: TokenCheck) => {
      if (checkSeq.current[key] === mine) setRemoteCheck((c) => ({ ...c, [key]: value }));
    };
    window.cth.mcpRemoteTestToken(id, project).then(land, () => land('unreachable'));
  };
  useEffect(() => {
    const rows = MCP_CATALOG.filter((e) => e.remote).flatMap((e) =>
      Object.keys(config.mcpDefaults?.[e.id]?.projects ?? {}).map((k) => [e.id, k] as const));
    void Promise.all(rows.map(([id, k]) => window.cth.mcpRemoteHasToken(id, k))).then(
      (values) => {
        setRemoteHasToken(Object.fromEntries(rows.map(([id, k], i) => [remoteKey(id, k), values[i]])));
        rows.forEach(([id, k], i) => { if (values[i]) checkRemoteToken(id, k); else setCheck(id, k, 'missing'); });
      }, () => undefined);
  }, [remoteRowsKey]);
  const fail = () => { setNote(t('mcpDefaults.couldNotSave')); setTimeout(() => setNote(''), 2000); };
  const patchRemoteProject = (id: string, project: string, value: N8nProjectEntry) =>
    writeConsentPatch(id, n8nProjectOps.upsert(project, value)).catch(fail);
  const saveRemoteToken = async (id: string, project: string, token: string) => {
    if (!token.trim()) return; // an empty blur never touches the stored token; Clear is explicit
    try {
      const res = await window.cth.mcpRemoteSetToken(id, project, token);
      if (!res.ok) throw new Error(res.error);
      setRemoteHasToken((h) => ({ ...h, [remoteKey(id, project)]: true }));
      checkRemoteToken(id, project);
    } catch { fail(); }
  };
  const clearRemoteToken = async (id: string, project: string): Promise<boolean> => {
    try {
      if (!(await window.cth.mcpRemoteClearToken(id, project)).ok) throw new Error('not cleared');
      setRemoteHasToken((h) => ({ ...h, [remoteKey(id, project)]: false }));
      setCheck(id, project, 'missing');
      return true;
    } catch { fail(); return false; }
  };
  // Keep the n8n IPC compatibility path and its verified-clear behavior.
  const clearN8nToken = async (project: string): Promise<boolean> => {
    try {
      if (!(await window.cth.mcpN8nClearToken(project)).ok) throw new Error('not cleared');
      setRemoteHasToken((h) => ({ ...h, [remoteKey('n8n', project)]: false }));
      setCheck('n8n', project, 'missing');
      return true;
    } catch { fail(); return false; }
  };
  const removeN8nProject = async (project: string) => {
    if (!(await removeN8nProjectFlow(project, () => clearN8nToken(project), (p) => writeConsentPatch('n8n', p)))) {
      if (!mcpDefaultsRef.current?.n8n?.projects?.[project]) return;
      fail();
    }
  };
  const removeRemoteProject = async (id: string, project: string) => {
    if (!(await removeN8nProjectFlow(project, () => clearRemoteToken(id, project), (p) => writeConsentPatch(id, p)))) {
      if (!mcpDefaultsRef.current?.[id]?.projects?.[project]) return;
      fail();
    }
  };
  const tokenBadge = (id: string, project: string): string => {
    const key = remoteKey(id, project);
    const c = remoteCheck[key] ?? (remoteHasToken[key] ? 'checking' : 'missing');
    return t({ missing: 'mcpDefaults.n8nTokenBadgeMissing', valid: 'mcpDefaults.n8nTokenValid', invalid: 'mcpDefaults.n8nTokenInvalid', unreachable: id === 'n8n' ? 'mcpDefaults.n8nTokenUnreachable' : 'mcpDefaults.remoteTokenUnreachable', checking: 'mcpDefaults.n8nTokenChecking' }[c], { name: MCP_CATALOG.find((e) => e.id === id)?.label ?? id });
  };
  const addRemoteProject = async (id: string) => {
    const project = (remoteNewProject[id] ?? '').trim();
    if (!isN8nProjectKey(project) || Object.prototype.hasOwnProperty.call(remoteProjects(id), project)) { fail(); return; }
    const agents = remoteNewAgents[id] ?? [];
    setRemoteNewProject((v) => ({ ...v, [id]: '' }));
    setRemoteNewAgents((v) => ({ ...v, [id]: [] }));
    setRemoteOpen((v) => ({ ...v, [remoteKey(id, project)]: true }));
    await patchRemoteProject(id, project, { url: '', agents });
  };

  const onInstall = async (id: string) => {
    setInstalling(id);
    try {
      const res = await window.cth.mcpInstall(id);
      if (!res.ok) {
        setNote(t('mcpDefaults.installFailed', { error: res.error }));
        setTimeout(() => setNote(''), 4000);
        return;
      }
      await patchConsent(id, { command: res.command, args: res.args });
    } finally {
      setInstalling(null);
    }
  };

  const byTier = (tier: McpTier) => MCP_CATALOG.filter((e) => e.tier === tier);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ ...labelStyle, marginBottom: 6 }}>{t('mcpDefaults.title')}</div>
        <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
          {t('mcpDefaults.desc')}
        </span>
      </div>

      {TIER_ORDER.map((tier) => {
        const entries = byTier(tier);
        if (entries.length === 0) return null;
        const isConsent = tier !== 'safe-readonly';
        return (
          <div key={tier} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                color: isConsent ? '#6E1423' : 'var(--cth-ink-500)',
                textTransform: 'uppercase'
              }}>
                {t(TIER_LABEL_KEY[tier])}
              </span>
              <span style={{ fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-400, var(--cth-ink-500))' }}>
                {t(TIER_NOTE_KEY[tier])}
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {entries.map((entry) => {
                const on = enabledFor(entry.id);
                return (
                  <div
                    key={entry.id}
                    style={{
                      display: 'flex', alignItems: entry.userConfigured || entry.remote ? 'flex-start' : 'center', justifyContent: 'space-between',
                      gap: 12, padding: '7px 10px',
                      background: 'var(--cth-paper-100)',
                      boxShadow: `inset 0 0 0 1px ${isConsent && on ? '#6E1423' : 'var(--cth-ink-300)'}`
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: entry.userConfigured ? 6 : 1, flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 12, lineHeight: '18px', color: 'var(--cth-ink-900)', fontWeight: 600 }}>
                        {entry.label}
                        <code style={{
                          marginLeft: 6,
                          fontFamily: 'var(--cth-font-mono)',
                          fontSize: 11,
                          color: 'var(--cth-ink-500)',
                          fontWeight: 400
                        }}>{entry.id}</code>
                      </span>
                      <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)', wordBreak: 'break-word' }}>
                        {entry.description}
                      </span>

                      {entry.userConfigured && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                          <span style={{ fontSize: 11, lineHeight: '15px', color: presence[entry.id]?.ok ? 'var(--cth-mint)' : '#6E1423' }}>
                            {presence[entry.id]?.ok
                              ? t('mcpDefaults.presenceOk')
                              : t(`mcpDefaults.presence.${presence[entry.id]?.reason ?? 'not_configured'}`, { detail: presence[entry.id]?.detail ?? '' })}
                          </span>

                          {/* First-run setup. When the server cannot run yet, the
                              install route leads and the manual fields below are
                              the fallback — a reader who has just arrived should
                              not have to guess that Install fills those fields in
                              for them. Same `canInstallMcp` guard the button has
                              always used, so `credentials_missing` (which install
                              cannot fix) still shows no call to action. */}
                          {canInstallMcp(entry.id, presence[entry.id]) && (
                            <div style={{
                              display: 'flex', flexDirection: 'column', gap: 4,
                              padding: '8px 10px', background: 'var(--cth-cream-200)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
                            }}>
                              <span style={{ ...labelStyle, color: 'var(--cth-ink-900)' }}>{t('mcpDefaults.setupTitle')}</span>
                              <span style={{ fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-700)' }}>
                                {t('mcpDefaults.setupIntro')}
                              </span>
                              <span style={{ fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)' }}>
                                {t('mcpDefaults.setupAfter')}
                              </span>
                              {/* Spec §E: the Install button SHOWS the destination
                                  before proceeding. Installing clones, builds and
                                  later runs third-party code, so the user sees
                                  where that lands before they click. The path
                                  comes from main's own derivation — the same one
                                  the installer uses — never from here. */}
                              {presence[entry.id]?.installDest && (
                                <span style={{ fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)', wordBreak: 'break-all' }}>
                                  {t('mcpDefaults.installDest', { path: presence[entry.id]?.installDest })}
                                </span>
                              )}
                              <button
                                type="button"
                                disabled={installing === entry.id}
                                onClick={() => { void onInstall(entry.id); }}
                                style={{
                                  alignSelf: 'flex-start', marginTop: 2, padding: '3px 10px 1px',
                                  background: 'var(--cth-paper-100)',
                                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
                                  border: 'none', fontFamily: 'var(--cth-font-display)',
                                  fontSize: 8, lineHeight: '14px', color: 'var(--cth-ink-900)',
                                  cursor: installing === entry.id ? 'default' : 'pointer',
                                  textTransform: 'uppercase'
                                }}
                              >
                                {installing === entry.id ? t('mcpDefaults.installing') : t('mcpDefaults.install')}
                              </button>
                            </div>
                          )}

                          <label style={labelStyle}>{t('mcpDefaults.command')}</label>
                          <ConsentField
                            value={config.mcpDefaults?.[entry.id]?.command ?? ''}
                            onCommit={(v) => { void patchConsent(entry.id, { command: v.trim() }); }}
                            placeholder={t('mcpDefaults.commandPlaceholder')}
                            style={{ width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontSize: 12, color: 'var(--cth-ink-900)' }}
                          />
                          <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('mcpDefaults.commandHint')}</span>

                          <label style={labelStyle}>{t('mcpDefaults.args')}</label>
                          <ConsentField
                            multiline
                            rows={2}
                            value={(config.mcpDefaults?.[entry.id]?.args ?? []).join('\n')}
                            onCommit={(v) => {
                              void patchConsent(entry.id, {
                                args: v.split('\n').map((a) => a.trim()).filter(Boolean)
                              });
                            }}
                            placeholder={t('mcpDefaults.argsPlaceholder')}
                            style={{ width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontSize: 12, color: 'var(--cth-ink-900)' }}
                          />
                          <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('mcpDefaults.argsHint')}</span>

                          <label style={labelStyle}>{t('mcpDefaults.agents')}</label>
                          <ConsentField
                            value={(config.mcpDefaults?.[entry.id]?.agents ?? []).join(', ')}
                            onCommit={(v) => {
                              void patchConsent(entry.id, {
                                agents: v.split(',').map((a) => a.trim()).filter(Boolean)
                              });
                            }}
                            placeholder={t('mcpDefaults.agentsPlaceholder')}
                            style={{ width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontSize: 12, color: 'var(--cth-ink-900)' }}
                          />
                          <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('mcpDefaults.agentsHint')}</span>
                        </div>
                      )}

                      {entry.remote && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                          <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('mcpDefaults.remoteProjectsHint', { name: entry.label })}</span>
                          {Object.entries(config.mcpDefaults?.[entry.id]?.projects ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([project, pe]) => (
                            <div key={project} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }}>
                              <button
                                type="button"
                                aria-expanded={!!remoteOpen[remoteKey(entry.id, project)]}
                                onClick={() => setRemoteOpen((o) => ({ ...o, [remoteKey(entry.id, project)]: !o[remoteKey(entry.id, project)] }))}
                                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 0, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontSize: 11, color: 'var(--cth-ink-500)' }}
                              >
                                <span aria-hidden style={{ width: 10, display: 'inline-block', transform: remoteOpen[remoteKey(entry.id, project)] ? 'rotate(90deg)' : undefined, color: 'var(--cth-ink-700)' }}>▸</span>
                                <span style={{ ...labelStyle, flex: 1 }}>{project}</span>
                                <span>{normalizeRemoteUrl(entry.id, pe.url) ? t('mcpDefaults.n8nUrlOk') : pe.url ? t('mcpDefaults.n8nUrlInvalid') : t('mcpDefaults.n8nUrlMissing')}</span>
                                <span>{tokenBadge(entry.id, project)}</span>
                                <span>{t('mcpDefaults.n8nAgentsCount', { n: (pe.agents ?? []).length })}</span>
                              </button>
                              {remoteOpen[remoteKey(entry.id, project)] && (<>
                              <label style={labelStyle}>{t('mcpDefaults.remoteUrl', { name: entry.label })}</label>
                              <ConsentField
                                value={pe.url ?? ''}
                                onCommit={(v) => { if (remoteHasToken[remoteKey(entry.id, project)]) setCheck(entry.id, project, 'checking'); void patchRemoteProject(entry.id, project, { url: v.trim() }).then(() => { if (remoteHasToken[remoteKey(entry.id, project)]) checkRemoteToken(entry.id, project); }); }}
                                placeholder={t(entry.id === 'teamai' ? 'mcpDefaults.teamaiUrlPlaceholder' : 'mcpDefaults.n8nUrlPlaceholder')}
                                style={{ width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontSize: 12, color: 'var(--cth-ink-900)' }}
                              />
                              <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t(entry.id === 'teamai' ? 'mcpDefaults.teamaiUrlHint' : 'mcpDefaults.n8nUrlHint')}</span>

                              <label style={labelStyle}>{t('mcpDefaults.n8nToken')}</label>
                              <input
                                type="password"
                                autoComplete="off"
                                key={`${project}:${!!remoteHasToken[remoteKey(entry.id, project)]}`}
                                defaultValue={remoteHasToken[remoteKey(entry.id, project)] ? N8N_TOKEN_MASK : ''}
                                onFocus={(e) => { if (e.target.value === N8N_TOKEN_MASK) e.target.select(); }}
                                onBlur={(e) => { const v = e.target.value; if (v === N8N_TOKEN_MASK) return; e.target.value = remoteHasToken[remoteKey(entry.id, project)] ? N8N_TOKEN_MASK : ''; void saveRemoteToken(entry.id, project, v); }}
                                placeholder={t('mcpDefaults.n8nTokenPlaceholder')}
                                style={{ width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontSize: 12, color: 'var(--cth-ink-900)' }}
                              />
                              <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
                                {remoteHasToken[remoteKey(entry.id, project)] ? t('mcpDefaults.remoteTokenSet') : t('mcpDefaults.remoteTokenHint', { name: entry.label })}
                              </span>
                              {remoteHasToken[remoteKey(entry.id, project)] && (
                                <button type="button" onClick={() => { checkRemoteToken(entry.id, project); }} disabled={remoteCheck[remoteKey(entry.id, project)] === 'checking'} style={{ alignSelf: 'flex-start', padding: '3px 10px 1px', background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', border: 'none', fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '14px', color: 'var(--cth-ink-900)', cursor: 'pointer', textTransform: 'uppercase' }}>
                                  {t('mcpDefaults.n8nTokenVerify')}
                                </button>
                              )}
                              {remoteHasToken[remoteKey(entry.id, project)] && (
                                <button type="button" onClick={() => { void (entry.id === 'n8n' ? clearN8nToken(project) : clearRemoteToken(entry.id, project)); }} style={{ alignSelf: 'flex-start', padding: '3px 10px 1px', background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', border: 'none', fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '14px', color: 'var(--cth-ink-900)', cursor: 'pointer', textTransform: 'uppercase' }}>
                                  {t('mcpDefaults.n8nTokenClear')}
                                </button>
                              )}

                              <label style={labelStyle}>{t('mcpDefaults.agents')}</label>
                              <N8nAgentPicker project={project} value={pe.agents ?? []} onChange={(v) => { void patchRemoteProject(entry.id, project, { agents: v }); }} />
                              <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('mcpDefaults.remoteAgentsHint', { name: entry.label })}</span>
                              <button type="button" onClick={() => { void (entry.id === 'n8n' ? removeN8nProject(project) : removeRemoteProject(entry.id, project)); }} style={{ alignSelf: 'flex-start', padding: '3px 10px 1px', background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', border: 'none', fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '14px', color: 'var(--cth-ink-900)', cursor: 'pointer', textTransform: 'uppercase' }}>
                                {t('mcpDefaults.n8nProjectRemove')}
                              </button>
                              </>)}
                            </div>
                          ))}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <select
                              value={remoteNewProject[entry.id] ?? ''}
                              aria-label={t('mcpDefaults.n8nProject')}
                              onChange={(e) => { setRemoteNewProject((v) => ({ ...v, [entry.id]: e.target.value })); setRemoteNewAgents((v) => ({ ...v, [entry.id]: [] })); }}
                              style={{ width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontSize: 12, color: 'var(--cth-ink-900)' }}
                            >
                              <option value="">{t('mcpDefaults.n8nProjectPick')}</option>
                              {remoteProjectChoices(entry.id).map((k) => <option key={k} value={k}>{k}</option>)}
                            </select>
                            <N8nAgentPicker project={remoteNewProject[entry.id] ?? ''} value={remoteNewAgents[entry.id] ?? []} onChange={(agents) => setRemoteNewAgents((v) => ({ ...v, [entry.id]: agents }))} />
                            <button type="button" disabled={!remoteNewProject[entry.id]} onClick={() => { void addRemoteProject(entry.id); }} style={{ alignSelf: 'flex-start', padding: '3px 10px 1px', background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', border: 'none', fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '14px', color: 'var(--cth-ink-900)', cursor: 'pointer', textTransform: 'uppercase' }}>
                              {t('mcpDefaults.n8nProjectAdd')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => { void toggle(entry.id); }}
                      style={{
                        flexShrink: 0,
                        padding: '3px 10px 1px',
                        background: on
                          ? (isConsent ? 'var(--cth-coral-light, #f6d3c4)' : 'var(--cth-lemon)')
                          : 'var(--cth-cream-200)',
                        boxShadow: `inset 0 0 0 1px ${on ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}`,
                        border: 'none',
                        fontFamily: 'var(--cth-font-display)',
                        fontSize: 8,
                        lineHeight: '14px',
                        color: 'var(--cth-ink-900)',
                        cursor: 'pointer',
                        textTransform: 'uppercase'
                      }}
                    >
                      {on ? t('common.on') : t('common.off')}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {note && (
        <span style={{ fontSize: 12, color: 'var(--cth-mint)' }}>{note}</span>
      )}
    </div>
  );
}

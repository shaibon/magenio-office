import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import { MCP_CATALOG, mergeMcpConsent, type McpTier } from '@shared/mcpCatalog';
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
function ConsentField({ value, onCommit, multiline, rows, style }: ConsentFieldProps) {
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
    <textarea rows={rows} value={draft} onChange={handleChange} onFocus={handleFocus} onBlur={handleBlur} style={style} />
  ) : (
    <input value={draft} onChange={handleChange} onFocus={handleFocus} onBlur={handleBlur} style={style} />
  );
}

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

  // Serializes the actual `updateConfig` IPC calls. Merging against
  // `mcpDefaultsRef` alone isn't enough: each write's payload is already a
  // full, correctly-merged snapshot, but if two writes are in flight at once
  // and complete out of order, the earlier (smaller) snapshot landing after
  // the later (larger) one would still overwrite it. Chaining every write
  // onto this queue guarantees they land in the order they were issued.
  const writeQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  /** Merge `patch` into consent entry `id` against the latest known state and
   *  queue the write. Returns the real write promise (rejects on failure);
   *  the queue itself is kept always-resolved so one failed write never
   *  stalls the ones queued after it. */
  const writeConsentPatch = (
    id: string,
    patch: { enabled?: boolean; agents?: string[]; command?: string; args?: string[] }
  ): Promise<unknown> => {
    const base = mcpDefaultsRef.current ?? {};
    // `mergeMcpConsent` — not a hand-rolled spread — is what applies the
    // catalog's `defaultAgents` allow-list, so a server that ships restricted
    // to specific agents is restricted by the FIRST write this panel makes
    // (enabling it, or an Install pre-filling command/args), rather than only
    // once the user remembers to type an allow-list. An allow-list the user
    // deliberately emptied is left alone; see mergeMcpConsent.
    const mergedDefaults = { ...base, [id]: mergeMcpConsent(id, base[id], patch) };
    mcpDefaultsRef.current = mergedDefaults;

    const run = () => window.cth.updateConfig({ mcpDefaults: mergedDefaults });
    const result = writeQueueRef.current.then(run, run);
    writeQueueRef.current = result.then(() => undefined, () => undefined);
    return result;
  };

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
  const patchConsent = async (id: string, p: { command?: string; args?: string[]; agents?: string[] }) => {
    try {
      await writeConsentPatch(id, p);
      await refreshPresence();
    } catch {
      setNote(t('mcpDefaults.couldNotSave'));
      setTimeout(() => setNote(''), 2000);
    }
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
                      display: 'flex', alignItems: entry.userConfigured ? 'flex-start' : 'center', justifyContent: 'space-between',
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

                          <label style={labelStyle}>{t('mcpDefaults.command')}</label>
                          <ConsentField
                            value={config.mcpDefaults?.[entry.id]?.command ?? ''}
                            onCommit={(v) => { void patchConsent(entry.id, { command: v.trim() }); }}
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
                            style={{ width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontSize: 12, color: 'var(--cth-ink-900)' }}
                          />
                          <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('mcpDefaults.agentsHint')}</span>

                          {canInstallMcp(entry.id, presence[entry.id]) && (
                            <>
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
                                  alignSelf: 'flex-start', padding: '3px 10px 1px',
                                  background: 'var(--cth-cream-200)',
                                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
                                  border: 'none', fontFamily: 'var(--cth-font-display)',
                                  fontSize: 8, lineHeight: '14px', color: 'var(--cth-ink-900)',
                                  cursor: installing === entry.id ? 'default' : 'pointer',
                                  textTransform: 'uppercase'
                                }}
                              >
                                {installing === entry.id ? t('mcpDefaults.installing') : t('mcpDefaults.install')}
                              </button>
                            </>
                          )}
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

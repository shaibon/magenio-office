import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import { MCP_CATALOG, type McpTier } from '@shared/mcpCatalog';

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

export function McpDefaultsSettings({ config }: McpDefaultsSettingsProps) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');

  const enabledFor = (id: string): boolean =>
    config.mcpDefaults?.[id]?.enabled ?? MCP_CATALOG.find((e) => e.id === id)?.defaultEnabled ?? false;

  const toggle = async (id: string) => {
    const next = !enabledFor(id);
    try {
      await window.cth.updateConfig({
        // Spread the existing entry: enabled is no longer the only field, and
        // replacing the object would wipe a configured command/args/agents.
        mcpDefaults: {
          ...(config.mcpDefaults ?? {}),
          [id]: { ...(config.mcpDefaults?.[id] ?? {}), enabled: next }
        }
      });
      setNote(t('mcpDefaults.toggleNote', { id, state: next ? t('common.on') : t('common.off') }));
      setTimeout(() => setNote(''), 1800);
    } catch {
      setNote(t('mcpDefaults.couldNotSave'));
      setTimeout(() => setNote(''), 2000);
    }
  };

  const [presence, setPresence] = useState<Record<string, { ok: boolean; reason?: string; detail?: string }>>({});
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
    const current = config.mcpDefaults?.[id] ?? { enabled: enabledFor(id) };
    try {
      await window.cth.updateConfig({
        mcpDefaults: { ...(config.mcpDefaults ?? {}), [id]: { ...current, ...p } }
      });
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
                          <input
                            defaultValue={config.mcpDefaults?.[entry.id]?.command ?? ''}
                            onBlur={(e) => { void patchConsent(entry.id, { command: e.target.value.trim() }); }}
                            style={{ width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontSize: 12, color: 'var(--cth-ink-900)' }}
                          />
                          <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('mcpDefaults.commandHint')}</span>

                          <label style={labelStyle}>{t('mcpDefaults.args')}</label>
                          <textarea
                            rows={2}
                            defaultValue={(config.mcpDefaults?.[entry.id]?.args ?? []).join('\n')}
                            onBlur={(e) => {
                              void patchConsent(entry.id, {
                                args: e.target.value.split('\n').map((a) => a.trim()).filter(Boolean)
                              });
                            }}
                            style={{ width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontSize: 12, color: 'var(--cth-ink-900)' }}
                          />
                          <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('mcpDefaults.argsHint')}</span>

                          <label style={labelStyle}>{t('mcpDefaults.agents')}</label>
                          <input
                            defaultValue={(config.mcpDefaults?.[entry.id]?.agents ?? []).join(', ')}
                            onBlur={(e) => {
                              void patchConsent(entry.id, {
                                agents: e.target.value.split(',').map((a) => a.trim()).filter(Boolean)
                              });
                            }}
                            style={{ width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontSize: 12, color: 'var(--cth-ink-900)' }}
                          />
                          <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('mcpDefaults.agentsHint')}</span>

                          {/* No install button for credentials_missing: no install can
                              fix it, only the user editing the server's own .env. */}
                          {entry.id === 'trello'
                            && !presence[entry.id]?.ok
                            && presence[entry.id]?.reason !== 'credentials_missing' && (
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

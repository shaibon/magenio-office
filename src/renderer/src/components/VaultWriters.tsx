import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { createOriginResolver } from '@shared/originResolver';
import { addWriter, eligibleWriters, removeWriter, writerChips, type WriterAgent } from '@shared/vaultWriters';

/** One resolver for the whole Settings session, shared by every project's panel. */
const originResolver = createOriginResolver((cwd) => window.cth.gitRemoteUrl(cwd));

/** "Vault writers" for one Vault Sync project mapping: pick which of the project's
 *  live agents may write its vault folder. Agents are matched to the project by git
 *  origin (resolved here per cwd, like main does), never by name. */
export function VaultWriters({ repoOrigin, value, onChange }: {
  repoOrigin: string;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const live = useStore((s) => s.agents);
  const archived = useStore((s) => s.archivedAgents);
  const [origins, setOrigins] = useState<Record<string, string | null>>({});

  // Only live agents can be offered or judged by origin; archived ones are flagged
  // by state alone, so they never cost a lookup.
  const liveCwds = useMemo(() => [...new Set(live.map((a) => a.cwd))].sort(), [live]);
  const cwdKey = liveCwds.join('\n');
  const mounted = useRef(true);
  // Latest request per cwd: an older answer arriving late never overwrites a newer one.
  const seq = useRef<Record<string, number>>({});
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // The effect depends on the SET of cwds only. It used to depend on its own result
  // map and cancel on every re-run, which dropped in-flight answers and re-asked for
  // them: dozens of agents x one panel per project turned into a storm of git spawns
  // that left the select empty or stuck. Answers now always land (shared resolver).
  useEffect(() => {
    for (const cwd of liveCwds) {
      const mine = (seq.current[cwd] = (seq.current[cwd] ?? 0) + 1);
      void originResolver.get(cwd).then((o) => {
        if (mounted.current && seq.current[cwd] === mine) setOrigins((p) => (cwd in p && p[cwd] === o ? p : { ...p, [cwd]: o }));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwdKey]);

  const all = useMemo(() => [...live.map((a) => ({ a, archived: false })), ...archived.map((a) => ({ a, archived: true }))], [live, archived]);
  const agents: WriterAgent[] = all.map(({ a, archived: arch }) => ({
    id: a.id, name: a.name, archived: arch, origin: arch ? null : origins[a.cwd]
  }));
  const options = eligibleWriters(repoOrigin, value, agents);
  const chips = writerChips(repoOrigin, value, agents);
  const warn = (s: string) => s !== 'ok';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--cth-ink-900)' }}>{t('vaultWriters.title')}</span>
      <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('vaultWriters.hint')}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {chips.map((c) => (
          <span key={c.id} title={warn(c.state) ? t(`vaultWriters.warn.${c.state}`) : c.id} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 4px 1px 6px', fontSize: 12,
            background: 'var(--cth-cream-200)', color: 'var(--cth-ink-900)',
            boxShadow: `inset 0 0 0 1px ${warn(c.state) ? 'var(--cth-red, #b3261e)' : 'var(--cth-ink-100)'}`
          }}>
            {warn(c.state) && <span aria-hidden="true" style={{ color: 'var(--cth-red, #b3261e)' }}>⚠</span>}
            {c.name}
            {warn(c.state) && <span style={{ fontSize: 11, color: 'var(--cth-red, #b3261e)' }}>{t(`vaultWriters.warn.${c.state}`)}</span>}
            <button
              type="button" onClick={() => onChange(removeWriter(value, c.id))}
              aria-label={t('vaultWriters.remove', { name: c.name })}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, color: 'var(--cth-ink-500)' }}
            >×</button>
          </span>
        ))}
      </div>
      <select
        value="" disabled={!repoOrigin || options.length === 0} aria-label={t('vaultWriters.add')}
        onChange={(e) => { if (e.target.value) onChange(addWriter(value, e.target.value)); }}
        style={{
          fontSize: 12, padding: '3px 6px', background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)',
          border: '1px solid var(--cth-ink-100)'
        }}
      >
        <option value="">{!repoOrigin ? t('vaultWriters.pickProjectFirst') : options.length === 0 ? t('vaultWriters.none') : t('vaultWriters.add')}</option>
        {options.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
    </div>
  );
}

import { useEffect, useSyncExternalStore } from 'react';

/** One shared, display-only record of which agents are hibernated (t-284): seeded from main once per
 *  id, then kept live by the `hive:agentHibernation` event. Every place that shows an agent's
 *  status reads it, so 'hibernated' is the same everywhere instead of a per-component patch. */
let hibernated: ReadonlySet<string> = new Set();
const seeded = new Set<string>();
const listeners = new Set<() => void>();
let unsubscribeEvent: (() => void) | undefined;

function setMember(id: string, on: boolean): void {
  if (hibernated.has(id) === on) return;
  const next = new Set(hibernated);
  if (on) next.add(id); else next.delete(id);
  hibernated = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  unsubscribeEvent ??= window.cth.onHiveAgentHibernation?.((e) => { seeded.add(e.id); setMember(e.id, e.hibernated); });
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { unsubscribeEvent?.(); unsubscribeEvent = undefined; }
  };
}

function seed(ids: string[]): void {
  for (const id of ids) {
    if (!id || seeded.has(id)) continue;
    seeded.add(id);
    void window.cth.hibernateState?.(id).then((s) => { if (s?.hibernated) setMember(id, true); })
      .catch(() => { seeded.delete(id); /* not available — retry on next mount */ });
  }
}

/** Ids of the agents that are hibernated right now. Pass the ids on screen so they get seeded. */
export function useHibernatedIds(agentIds: string[]): ReadonlySet<string> {
  const key = agentIds.join('|');
  useEffect(() => { seed(key ? key.split('|') : []); }, [key]);
  return useSyncExternalStore(subscribe, () => hibernated);
}

/** Single-agent form of the above. */
export function useIsHibernated(agentId: string | undefined): boolean {
  const ids = useHibernatedIds(agentId ? [agentId] : []);
  return !!agentId && ids.has(agentId);
}

/** The status to DISPLAY: hibernated replaces idle only (a hibernated agent has no live turn). */
export function displayStatus<S extends string>(status: S, isHibernated: boolean): S | 'hibernated' {
  return isHibernated && status === 'idle' ? 'hibernated' : status;
}

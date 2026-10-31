/** Shared, display-only record of which agents are hibernated (t-284). Plain module (no React) so
 *  its orderings can be tested: seeded from main, kept live by the hibernation event. */
export interface HibernationBridge {
  hibernateState?: (id: string) => Promise<{ hibernated?: boolean } | null | undefined>;
  onHiveAgentHibernation?: (cb: (e: { id: string; hibernated: boolean }) => void) => (() => void) | void;
}

export function createHibernatedStore(bridge: () => HibernationBridge) {
  let hibernated: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  /** Bumped by every event for an id: a seed reply older than the event is discarded. */
  const version = new Map<string, number>();
  const seeded = new Set<string>();
  let unsubscribeEvent: (() => void) | undefined;

  const setMember = (id: string, on: boolean): void => {
    if (hibernated.has(id) === on) return;
    const next = new Set(hibernated);
    if (on) next.add(id); else next.delete(id);
    hibernated = next;
    listeners.forEach((l) => l());
  };

  const subscribe = (listener: () => void): (() => void) => {
    if (!listeners.size) {
      // Events were not heard while nobody was subscribed, so every id must be re-read on remount.
      seeded.clear();
      unsubscribeEvent = bridge().onHiveAgentHibernation?.((e) => {
        version.set(e.id, (version.get(e.id) ?? 0) + 1);
        setMember(e.id, e.hibernated);
      }) || undefined;
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) { unsubscribeEvent?.(); unsubscribeEvent = undefined; }
    };
  };

  const seed = (ids: string[]): void => {
    for (const id of ids) {
      if (!id || seeded.has(id)) continue;
      seeded.add(id);
      const v = version.get(id) ?? 0;
      void Promise.resolve(bridge().hibernateState?.(id)).then((s) => {
        if (s && (version.get(id) ?? 0) === v) setMember(id, !!s.hibernated);
      }).catch(() => { seeded.delete(id); /* not available — retry on next mount */ });
    }
  };

  return { subscribe, seed, snapshot: () => hibernated };
}

/** The status to DISPLAY: once the process is gone the agent is hibernated whatever it last said. */
export function displayStatus<S extends string>(status: S, isHibernated: boolean): S | 'hibernated' {
  return isHibernated ? 'hibernated' : status;
}

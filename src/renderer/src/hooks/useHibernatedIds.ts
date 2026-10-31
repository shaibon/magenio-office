import { useEffect, useSyncExternalStore } from 'react';
import { createHibernatedStore } from './hibernatedStore';

export { displayStatus } from './hibernatedStore';

/** One shared store for every place that shows an agent's status (t-284), so 'hibernated' reads the
 *  same everywhere instead of being patched per component. */
const store = createHibernatedStore(() => window.cth);

/** Ids of the agents that are hibernated right now. Pass the ids on screen so they get seeded. */
export function useHibernatedIds(agentIds: string[]): ReadonlySet<string> {
  const key = agentIds.join('|');
  const set = useSyncExternalStore(store.subscribe, store.snapshot);
  // After the subscribe effect (declared first) so a remount reseeds ids the store forgot.
  useEffect(() => { store.seed(key ? key.split('|') : []); }, [key]);
  return set;
}

/** Single-agent form of the above. */
export function useIsHibernated(agentId: string | undefined): boolean {
  const ids = useHibernatedIds(agentId ? [agentId] : []);
  return !!agentId && ids.has(agentId);
}

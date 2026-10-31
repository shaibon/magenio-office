import { useEffect, useState } from 'react';

/** Ids of the agents that are hibernated right now (t-283): seeded from main for the ids on the
 *  floor, then kept live by the `hive:agentHibernation` event. Display-only. */
export function useHibernatedIds(agentIds: string[]): Set<string> {
  const [ids, setIds] = useState<Set<string>>(new Set());
  const key = agentIds.join('|');
  useEffect(() => {
    let alive = true;
    for (const id of key ? key.split('|') : []) {
      void window.cth.hibernateState?.(id).then((s) => {
        if (alive && s?.hibernated) setIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
      }).catch(() => { /* not available */ });
    }
    return () => { alive = false; };
  }, [key]);
  useEffect(() => window.cth.onHiveAgentHibernation?.((e) => {
    setIds((prev) => {
      if (prev.has(e.id) === e.hibernated) return prev;
      const next = new Set(prev);
      if (e.hibernated) next.add(e.id); else next.delete(e.id);
      return next;
    });
  }), []);
  return ids;
}

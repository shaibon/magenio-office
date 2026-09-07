import { useEffect, useMemo, useState } from 'react';
import { useStore, type Agent } from '@/store/store';
import { useResolvedRepoNames } from '@/hooks/useResolvedRepoNames';
import {
  mergeRecoveryRows,
  type RegistryRecoverySource
} from '@shared/registryRecovery';

/**
 * Registry-backed recovery for the Command Center's Archived list.
 *
 * The renderer's `archivedAgents` and `restorableAgents` are localStorage
 * caches: an agent only enters them by passing through the floor, so an agent
 * that fell out of `agents` another way (archive in main, restart, crash) can
 * be missing from BOTH lists even though registry.json still knows it and its
 * memory/inbox are intact on disk.
 *
 * This hook fetches `window.cth.hiveRegistry()` and adds every registry agent
 * that is NOT already visible in the floor roster, the archived list, or the
 * restorable dropdown. Conversion/defaulting lives in the pure shared helpers
 * (`@shared/registryRecovery`) so node:test can pin the id/cwd preservation and
 * the dedupe rules without a renderer harness.
 */
export function useRegistryArchivedAgents(): Agent[] {
  const archivedAgents = useStore((s) => s.archivedAgents);
  const agents = useStore((s) => s.agents);
  const restorableAgents = useStore((s) => s.restorableAgents);
  const [registryEntries, setRegistryEntries] = useState<RegistryRecoverySource[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.cth.hiveRegistry()
      .then((reg) => {
        if (cancelled) return;
        setRegistryEntries(Object.values(reg.agents ?? {}) as RegistryRecoverySource[]);
      })
      .catch(() => {
        if (!cancelled) setRegistryEntries([]);
      });
    return () => { cancelled = true; };
  }, []);

  const rows = useMemo(() => {
    // Agents already reachable somewhere else must not be duplicated here: the
    // live floor roster and the restorable dropdown already have their rows.
    const alreadyListedIds = new Set<string>();
    for (const a of agents) alreadyListedIds.add(a.id);
    for (const a of restorableAgents) alreadyListedIds.add(a.id);
    return mergeRecoveryRows(archivedAgents, registryEntries ?? [], alreadyListedIds) as Agent[];
  }, [archivedAgents, agents, restorableAgents, registryEntries]);

  // Same repo-label/Jira-key resolution every other flat list gets: registry
  // rows may carry no `project`, so their labels must come from their cwd via
  // the shared git-root resolver rather than from a stale static field.
  useResolvedRepoNames(rows);

  return rows;
}

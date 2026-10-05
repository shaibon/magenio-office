/**
 * Vault writers — which agents may be offered as writers of one mapped project's
 * vault folder, and how a saved id list reads back. Pure; the renderer resolves
 * each agent's git origin and hands it in. Matching is by exact origin, the same
 * rule main applies when it decides who gets the write tools.
 */

export interface WriterAgent {
  id: string;
  name: string;
  /** `git remote get-url origin` of the agent's cwd; null while unresolved or when it has none. */
  origin: string | null;
  archived: boolean;
}

export type WriterChipState = 'ok' | 'archived' | 'otherProject' | 'unknown';
export interface WriterChip { id: string; name: string; state: WriterChipState }

/** Live agents of this project that are not selected yet (the multi-select options). */
export function eligibleWriters(repoOrigin: string, selected: string[], agents: WriterAgent[]): WriterAgent[] {
  if (!repoOrigin) return [];
  const picked = new Set(selected);
  return agents.filter((a) => !a.archived && a.origin === repoOrigin && !picked.has(a.id));
}

/** One chip per saved id, flagged when it would not pass the filter today. A
 *  still-unresolved origin is not judged: it reads 'ok' rather than raising a false warning. */
export function writerChips(repoOrigin: string, selected: string[], agents: WriterAgent[]): WriterChip[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  return selected.map((id) => {
    const a = byId.get(id);
    if (!a) return { id, name: id, state: 'unknown' };
    if (a.archived) return { id, name: a.name, state: 'archived' };
    if (a.origin !== null && a.origin !== repoOrigin) return { id, name: a.name, state: 'otherProject' };
    return { id, name: a.name, state: 'ok' };
  });
}

/** Add an id once; remove by id. Both keep order and never produce duplicates. */
export const addWriter = (selected: string[], id: string): string[] => (selected.includes(id) ? selected : [...selected, id]);
export const removeWriter = (selected: string[], id: string): string[] => selected.filter((x) => x !== id);

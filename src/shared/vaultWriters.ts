/**
 * Vault writers — which agents may be offered as writers of one mapped project's
 * vault folder, and how a saved id list reads back. Pure; the renderer resolves
 * each agent's git origin and hands it in. Matching is by exact origin, the same
 * rule main applies when it decides who gets the write tools.
 */

export interface WriterAgent {
  id: string;
  name: string;
  /** `git remote get-url origin` of the agent's cwd. undefined = still resolving; null = resolved, no origin. */
  origin: string | null | undefined;
  archived: boolean;
  /** Roster project tag (Jira key such as "BURD"); empty/absent when the agent has none. */
  project?: string;
  /** Role / job one-liner, e.g. "Documentation curator — keeps the README accurate…". */
  role?: string;
}

export type WriterChipState = 'ok' | 'archived' | 'otherProject' | 'noOrigin' | 'unknown';
export interface WriterChip { id: string; name: string; state: WriterChipState }

/** Short role: the part of the one-liner before the first dash ("Documentation curator"). */
export function roleShort(role: string | undefined): string {
  return (role ?? '').split(/\s[—–-]\s/)[0].trim().slice(0, 40);
}

/** Same-named agents must be told apart: "Angela · Documentation curator · angela-muvdk1xn". */
export function writerLabel(a: WriterAgent): string {
  return [a.name, roleShort(a.role), a.id].filter(Boolean).join(' · ');
}

const isDocs = (a: WriterAgent): boolean => /documentation|docs/i.test(a.role ?? '') || /^angela\b/i.test(a.name);

/** Belt and braces on top of the origin match: when the mapping's project keys are known
 *  (Jira bindings pointing at the same origin) and the agent carries a roster project, the
 *  two must agree. No keys, or an agent with no project, is not judged. */
export function projectAgrees(a: WriterAgent, projectKeys: string[]): boolean {
  const p = (a.project ?? '').trim().toLowerCase();
  if (!p || projectKeys.length === 0) return true;
  return projectKeys.some((k) => k.trim().toLowerCase() === p);
}

/** Names a mapping's project goes by: each Jira binding whose repo has the mapping's origin
 *  contributes its key AND its repo folder name. Agents hired later carry the folder name
 *  as their roster project (e.g. "magenio-M2-sardiniaecommerce"), older ones the key ("VAI"). */
export function projectNamesFor(bindings: { key: string; repo: string }[], origins: Record<string, string | null | undefined>, repoOrigin: string): string[] {
  return bindings
    .filter((b) => origins[b.repo] === repoOrigin)
    .flatMap((b) => [b.key, b.repo.split('/').filter(Boolean).pop() ?? '']);
}

/** Live agents of this project that are not selected yet (the multi-select options):
 *  unique by id, documentation agents first, then by name and id. */
export function eligibleWriters(repoOrigin: string, selected: string[], agents: WriterAgent[], projectKeys: string[] = []): WriterAgent[] {
  if (!repoOrigin) return [];
  const picked = new Set(selected);
  const seen = new Set<string>();
  return agents
    .filter((a) => {
      if (a.archived || a.origin !== repoOrigin || picked.has(a.id) || !projectAgrees(a, projectKeys) || seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    })
    .sort((a, b) => Number(isDocs(b)) - Number(isDocs(a)) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** One chip per saved id, flagged when it would not pass the filter today. A
 *  origin still being resolved (undefined) is not judged; one that resolved to nothing (null) is flagged. */
export function writerChips(repoOrigin: string, selected: string[], agents: WriterAgent[], projectKeys: string[] = []): WriterChip[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  return selected.map((id) => {
    const a = byId.get(id);
    if (!a) return { id, name: id, state: 'unknown' };
    const name = writerLabel(a);
    if (a.archived) return { id, name, state: 'archived' };
    if (a.origin === null) return { id, name, state: 'noOrigin' };
    if ((a.origin !== undefined && a.origin !== repoOrigin) || !projectAgrees(a, projectKeys)) return { id, name, state: 'otherProject' };
    return { id, name, state: 'ok' };
  });
}

/** Add an id once; remove by id. Both keep order and never produce duplicates. */
export const addWriter = (selected: string[], id: string): string[] => (selected.includes(id) ? selected : [...selected, id]);
export const removeWriter = (selected: string[], id: string): string[] => selected.filter((x) => x !== id);

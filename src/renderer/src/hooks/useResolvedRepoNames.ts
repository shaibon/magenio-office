import { useEffect, useState } from 'react';
import type { Agent } from '@/store/store';
import type { JiraProjectBinding } from '@shared/jiraProjects';

// Extracted from FullscreenTerminal.tsx (its roster-grouping logic) so
// CommandCenterPanel, AgentStrip, and AgentDetailPanel can show the SAME
// reliably-resolved project label next to an agent's name — the whole point
// being that two same-named agents on different projects (e.g. two "Andy"s)
// are never ambiguous to a human, in a flat list/dialog/toast as much as in
// the grouped roster this was originally built for.

export function basename(path: string): string {
  // Split on BOTH separators: `git:mainRepo` hands back whatever the platform
  // uses, and a Windows `C:\work\repo` contains no '/' at all — so a '/'-only
  // split returned the whole absolute path as the group's "name".
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** cwd → main-repo basename, resolved once per path and shared by every mount.
 *  An isolated agent's cwd is its own git worktree (`…/worktrees/<agent-id>`),
 *  so naming the group after that path buckets each such agent under its own id
 *  instead of the repository the user actually picked. `git:mainRepo` follows a
 *  linked worktree back to its main checkout. */
const repoRootByCwd = new Map<string, string | null>();
/** cwds with a lookup in flight, so a re-render can't start a second one. */
const repoLookupsInFlight = new Set<string>();

/** Which repository an agent belongs to — the ABSOLUTE root, so it is a real
 *  identity. Two unrelated checkouts can share a basename (`~/client-a/app` and
 *  `~/client-b/app`); keying groups on the name merged them into one section and
 *  let agents be dragged between two different repositories. */
export function repoKeyOf(agent: Agent): string {
  return repoRootByCwd.get(agent.cwd) || agent.cwd || 'unknown';
}

/** What that group is CALLED — the basename, or the project the user picked. */
export function repoLabelOf(agent: Agent): string {
  const root = repoRootByCwd.get(agent.cwd);
  if (root) return basename(root);
  const project = agent.project?.trim();
  if (project) return project;
  return basename(agent.cwd) || 'unknown';
}

/** Jira project bindings (Settings → Connections → Jira Projects), fetched
 *  once and shared module-wide, the same way `repoRootByCwd` is — so the
 *  agent tag can also carry the Jira KEY a project is bound to (e.g. "BURD"),
 *  not just its repo name. `null` = not fetched yet; `[]` is a valid "none
 *  configured" answer, so it must stay distinguishable from "not fetched". */
let jiraBindings: JiraProjectBinding[] | null = null;
let jiraBindingsPromise: Promise<JiraProjectBinding[]> | null = null;
function loadJiraBindings(): Promise<JiraProjectBinding[]> {
  if (jiraBindings) return Promise.resolve(jiraBindings);
  if (!jiraBindingsPromise) {
    jiraBindingsPromise = window.cth.jiraProjectsList()
      .catch(() => [] as JiraProjectBinding[])
      .then((list) => { jiraBindings = list; return list; });
  }
  return jiraBindingsPromise;
}

/** Whether an (enabled) binding covers this repo root and this agent — a
 *  binding scoped to specific `agents` applies only to those; an unscoped
 *  one (empty or absent `agents`) covers every agent in that repo. Pulled
 *  out of `jiraKeyFor` as its own pure function purely so it is unit-testable
 *  without a mounted React tree (the module-private caches it reads from
 *  need one to populate). */
export function bindingMatches(binding: JiraProjectBinding, repoRoot: string, agentId: string): boolean {
  return binding.enabled && binding.repo === repoRoot
    && (!binding.agents || binding.agents.length === 0 || binding.agents.includes(agentId));
}

/** The Jira key bound to an agent's repo, if any — matched on the resolved
 *  repo ROOT (never the raw cwd, which is the agent's own worktree for an
 *  isolated agent), and only once that root has actually resolved. */
export function jiraKeyFor(agent: Agent): string | undefined {
  if (!jiraBindings) return undefined;
  const root = repoRootByCwd.get(agent.cwd);
  if (!root) return undefined;
  return jiraBindings.find((b) => bindingMatches(b, root, agent.id))?.key;
}

/** Resolve every distinct cwd's repository root, then re-render. Exactly one git
 *  call per distinct path, ever — the cache above is module-level, so every
 *  caller of this hook (roster, pickers, toasts, detail headers) shares the
 *  same resolved names and only pays for a lookup once across all of them.
 *
 *  Also (best-effort, once) loads the Jira project bindings `jiraKeyFor`
 *  reads from — piggybacked on this same effect rather than a second hook,
 *  since every caller of this one already wants a re-render once either
 *  piece of data lands. */
export function useResolvedRepoNames(agents: Agent[]): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    if (!jiraBindings) {
      void loadJiraBindings().then(() => { if (!cancelled) setVersion(v => v + 1); });
    }
    const pending = [...new Set(agents.map(a => a.cwd).filter(Boolean))]
      // `has` (not a truthiness check) so a resolved-to-null path — a cwd that
      // is not a git repo — counts as answered. Caching only successes meant
      // every agent outside a repo re-asked on each pass, and this effect
      // depends on `agents`, which the pty parser replaces on every chunk of
      // terminal output: one such agent spawned `git rev-parse` continuously
      // for as long as it was talking. In-flight paths are skipped too, so a
      // re-render mid-lookup doesn't stack a second round of subprocesses.
      .filter(cwd => !repoRootByCwd.has(cwd) && !repoLookupsInFlight.has(cwd));
    if (pending.length === 0) return () => { cancelled = true; };
    pending.forEach(cwd => repoLookupsInFlight.add(cwd));
    void Promise.all(pending.map(async (cwd) => {
      try {
        repoRootByCwd.set(cwd, (await window.cth.gitMainRepo(cwd)) || null);
      } catch {
        // Record the failure as answered as well — retrying a path that throws
        // is what the unbounded-subprocess bug was made of.
        repoRootByCwd.set(cwd, null);
      } finally {
        repoLookupsInFlight.delete(cwd);
      }
    })).then(() => { if (!cancelled) setVersion(v => v + 1); });
    return () => { cancelled = true; };
  }, [agents]);
  return version;
}

/** " - KEY · Project" suffix for a name shown outside its own grouped/
 *  labelled context (a flat picker, a toast, a detail header) — empty for
 *  the god agent, who has no project and is never ambiguous. The Jira key
 *  piece is omitted when that repo has no (matching, enabled) binding. */
export function projectTag(agent: Agent): string {
  if (agent.isGod) return '';
  const key = jiraKeyFor(agent);
  return `${key ? ` - ${key}` : ''} · ${repoLabelOf(agent)}`;
}

/** Compact variant for DENSE lists (restore dropdown rows, fullscreen restore
 *  chips): when the repo has a Jira binding, ` - KEY · repoLabel` says the same
 *  project twice, so this shows only the key; without a binding it falls back
 *  to the repo label. Full disambiguation stays available in tooltips/titles
 *  via `projectTag`. Deliberately separate from `projectTag` — the long form is
 *  still right for pickers, toasts and detail headers. */
export function projectTagCompact(agent: Agent): string {
  if (agent.isGod) return '';
  const key = jiraKeyFor(agent);
  return ` · ${key ?? repoLabelOf(agent)}`;
}

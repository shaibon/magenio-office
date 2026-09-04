/**
 * Jira project mapping — canonical types + pure validators.
 *
 * Framework-agnostic (no node:fs, no electron): usable from both main
 * (src/main/jiraProjects.ts, src/main/config.ts, src/main/integrationBroker.ts)
 * and renderer (@shared/jiraProjects) the same way shared/integrations.ts is.
 *
 * Replaces the hand-written hive/jira-map.json. See
 * docs/superpowers/specs/2026-08-29-jira-project-mapping-design.md.
 */

import type { TrelloIntakeBinding } from './trelloIntake';

export interface JiraProjectBinding {
  /** Jira project key, e.g. "BURD". Immutable once created (identity for CRUD). */
  key: string;
  /** Absolute path to the local repo. */
  repo: string;
  /** Branch features are cut from and merged back into, e.g. "develop". */
  baseBranch: string;
  /** Agent ids that cover this project. Absent/empty = all agents. */
  agents?: string[];
  /** Trello source upstream of this project: the cards in these lists become
   *  issues of `key`. Absent = no Trello intake. Deliberately a field on the
   *  Jira binding and not a registry of its own — that makes a Trello source
   *  pointing at a deleted Jira project unrepresentable. */
  trello?: TrelloIntakeBinding;
  /** Exclude a project from the poll without deleting it. */
  enabled: boolean;
}

/** One entry in the poll's assignee allow-list. In JQL, displayName is not
 *  reliable — only `accountId` may be used to build `assignee in (...)`.
 *  `label` is UI-only (never read to build the query). */
export interface JiraAssigneeAllowlistEntry {
  accountId: string;
  label: string;
}

export interface JiraPollSettings {
  /** Default 300_000 (5 min). */
  pollIntervalMs: number;
  /** Fixed today (decided, not reopened in UI) but kept as data, not a hardcoded
   *  constant scattered across call sites. */
  assigneeFilter: 'currentUser';
  /** Default 'To Do'. */
  statusFilter: string;
  /** Additional Jira accountIds the poll may claim issues for, ON TOP OF
   *  `currentUser()` (never replacing it). Empty/absent = today's behavior
   *  (`assignee = currentUser()` only). Non-empty = `assignee in (currentUser(),
   *  ...accountIds)`, so a shared backlog assigned to someone else (e.g. a
   *  teammate's queue) becomes visible to the poll. Data, not a call-site
   *  constant — same convention as `statusFilter`. */
  assigneeAllowlist?: JiraAssigneeAllowlistEntry[];
}

export const DEFAULT_JIRA_POLL_SETTINGS: JiraPollSettings = {
  pollIntervalMs: 300_000,
  assigneeFilter: 'currentUser',
  statusFilter: 'To Do'
};

/** Jira project key shape: one uppercase letter, then 1-9 uppercase letters/digits
 *  (2-10 chars total) — matches real Atlassian project keys (BURD, BRAVI, ...). */
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;

/** Returns an error message, or null when the key format is valid. */
export function validateJiraKeyFormat(key: string): string | null {
  if (!key || !key.trim()) return 'Jira key is required.';
  if (!JIRA_KEY_RE.test(key.trim())) {
    return 'Jira key must be 2-10 uppercase letters/digits, starting with a letter (e.g. "BURD").';
  }
  return null;
}

/** Case-insensitive membership check against a list that must already exclude the
 *  binding being validated (the caller's responsibility — see jiraProjects.ts). */
export function hasDuplicateKey(key: string, otherBindings: JiraProjectBinding[]): boolean {
  const k = key.trim().toUpperCase();
  return otherBindings.some((b) => b.key.trim().toUpperCase() === k);
}

/** Parses the legacy hand-written hive/jira-map.json shape into the new config
 *  shape, for the one-shot migration in config.ts. Never throws — malformed JSON
 *  or an unexpected shape returns null so the caller can skip the import rather
 *  than crash config load. */
export function parseJiraMapJson(raw: string): { bindings: JiraProjectBinding[]; poll: Partial<JiraPollSettings> } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const rawProjects = Array.isArray(obj.projects) ? obj.projects : [];
  const bindings: JiraProjectBinding[] = [];
  for (const p of rawProjects) {
    if (!p || typeof p !== 'object') continue;
    const rp = p as Record<string, unknown>;
    if (typeof rp.key !== 'string' || typeof rp.repo !== 'string' || typeof rp.baseBranch !== 'string') continue;
    bindings.push({
      key: rp.key.trim().toUpperCase(),
      repo: rp.repo,
      baseBranch: rp.baseBranch,
      agents: Array.isArray(rp.agents) ? rp.agents.filter((a): a is string => typeof a === 'string') : undefined,
      enabled: true
    });
  }

  const poll: Partial<JiraPollSettings> = {};
  const rawFilter = obj.claimFilter;
  if (rawFilter && typeof rawFilter === 'object') {
    const rf = rawFilter as Record<string, unknown>;
    if (typeof rf.pollIntervalMs === 'number' && rf.pollIntervalMs > 0) poll.pollIntervalMs = rf.pollIntervalMs;
    if (typeof rf.status === 'string' && rf.status.trim()) poll.statusFilter = rf.status;
  }

  return { bindings, poll };
}

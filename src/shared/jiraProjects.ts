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
  /** Absolute path to this project's magento-mcp config JSON (holds DB/REST/SSH
   *  credentials). Absent = the Magento production MCP is NOT mounted for this
   *  project's agents (fail closed). */
  magentoMcpConfig?: string;
  /** Slack channel ids (e.g. "C03G9FGU2RE") whose messages belong to this project.
   *  The Slack trigger resolves channel -> project from here and tells god which
   *  project a request is about. Absent/empty = no channel; a channel maps to at
   *  most one project. */
  slackChannels?: string[];
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

/** Slack conversation id shape (public/private channel, group, DM): C/G/D + 8-14 uppercase alphanumerics. */
export const SLACK_CHANNEL_RE = /^[CGD][A-Z0-9]{8,14}$/;

/** Trims, uppercases, drops blanks and duplicates, keeps order. */
export function normalizeSlackChannels(list: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const c of list ?? []) {
    const id = String(c).trim().toUpperCase();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Error message, or null. `others` must exclude the binding being validated. */
export function validateSlackChannels(
  list: readonly string[] | undefined,
  others: readonly JiraProjectBinding[]
): string | null {
  for (const id of normalizeSlackChannels(list)) {
    if (!SLACK_CHANNEL_RE.test(id)) return `"${id}" is not a Slack channel id (e.g. "C03G9FGU2RE").`;
    const owner = others.find((b) => normalizeSlackChannels(b.slackChannels).includes(id));
    if (owner) return `Slack channel ${id} is already bound to ${owner.key}.`;
  }
  return null;
}

/** Legacy hive/slack-channels.json -> channel id => project key. Never throws. */
export function parseSlackChannelsJson(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const ch = (JSON.parse(raw) as { channels?: unknown })?.channels;
    if (!ch || typeof ch !== 'object') return out;
    for (const [id, v] of Object.entries(ch as Record<string, unknown>)) {
      const project = (v as { project?: unknown } | null)?.project;
      if (typeof project === 'string' && project.trim() && project.toUpperCase() !== 'ALL') {
        out[id.trim().toUpperCase()] = project.trim().toUpperCase();
      }
    }
  } catch { /* malformed -> empty */ }
  return out;
}

/** The project a Slack channel belongs to: an enabled binding's `slackChannels`
 *  first, then the legacy map as a fallback; null = unmapped (behaves as before). */
export function resolveSlackProject(
  bindings: readonly JiraProjectBinding[] | undefined,
  channel: string,
  legacy: Readonly<Record<string, string>> = {}
): string | null {
  const id = channel.trim().toUpperCase();
  if (!id) return null;
  const hit = (bindings ?? []).find((b) => b.enabled && normalizeSlackChannels(b.slackChannels).includes(id));
  return hit?.key ?? legacy[id] ?? null;
}

/** One-shot import: adds each legacy channel to the binding whose key matches its
 *  project (skipping ids already bound anywhere). Returns the same array when nothing changes. */
export function importSlackChannels(
  bindings: readonly JiraProjectBinding[],
  legacy: Readonly<Record<string, string>>
): JiraProjectBinding[] {
  const bound = new Set(bindings.flatMap((b) => normalizeSlackChannels(b.slackChannels)));
  let changed = false;
  const next = bindings.map((b) => {
    const add = Object.entries(legacy)
      .filter(([id, key]) => key === b.key.toUpperCase() && !bound.has(id) && SLACK_CHANNEL_RE.test(id))
      .map(([id]) => id);
    if (!add.length) return b;
    changed = true;
    add.forEach((id) => bound.add(id));
    return { ...b, slackChannels: [...normalizeSlackChannels(b.slackChannels), ...add] };
  });
  return changed ? next : (bindings as JiraProjectBinding[]);
}

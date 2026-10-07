/**
 * Jira project binding validation + config-backed CRUD (main process).
 *
 * Async validation is dependency-injected (isRepo/getBranches/agentExists/
 * testJiraKey) the same way integrationBroker.ts injects getRecord/getSecret —
 * so this stays unit-testable with fakes AND with the real git.ts helpers
 * against throwaway repos (see test/jira-projects-validate.test.cjs).
 */
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  type JiraProjectBinding,
  validateJiraKeyFormat,
  hasDuplicateKey,
  validateSlackChannels,
  normalizeGlitchtip,
  validateGlitchtip,
  normalizeSlackChannels,
  parseSlackChannelsJson,
  resolveSlackProject
} from '../shared/jiraProjects';
import { validateTrelloIntake } from '../shared/trelloIntake';
import { readConfig, writeConfig } from './config';
import { expandTilde } from './fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface JiraValidationDeps {
  isRepo: (cwd: string) => Promise<boolean>;
  getBranches: (cwd: string) => Promise<
    { local: string[]; remote: string[]; current: string | null } | { error: string }
  >;
  /** True when the agent id exists in the hive registry and is not archived. */
  agentExists: (id: string) => boolean;
  /** Probes the Jira REST API for the project key. Undefined when the `jira`
   *  integration isn't configured/enabled/has-a-secret yet — the check is then
   *  skipped rather than blocking (see spec §B.6). */
  testJiraKey?: (key: string) => Promise<{ ok: boolean; status?: number }>;
}

/** Validates one binding. `otherBindings` MUST already exclude the binding being
 *  edited (the caller filters by key before calling) — this function has no way
 *  to tell "editing myself" from "a real duplicate" otherwise. */
export async function validateJiraProjectBinding(
  binding: JiraProjectBinding,
  otherBindings: JiraProjectBinding[],
  deps: JiraValidationDeps
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Duplicate check runs before format validation: it's a plain case-insensitive
  // string comparison that doesn't care whether the key is well-formed, and a
  // duplicate of an already-valid key is a more specific, more useful error than
  // a generic format complaint would be.
  if (hasDuplicateKey(binding.key, otherBindings)) {
    return { ok: false, error: `A binding for "${binding.key.toUpperCase()}" already exists.` };
  }

  const formatError = validateJiraKeyFormat(binding.key);
  if (formatError) return { ok: false, error: formatError };

  if (!existsSync(binding.repo)) {
    return { ok: false, error: `Repo path does not exist: ${binding.repo}` };
  }
  if (!(await deps.isRepo(binding.repo))) {
    return { ok: false, error: `${binding.repo} is not a git repo.` };
  }

  const branches = await deps.getBranches(binding.repo);
  if ('error' in branches) {
    return { ok: false, error: `Could not read branches: ${branches.error}` };
  }
  // Checked against local+remote combined, for both the bare name and the
  // origin/-prefixed form: git's `refname:short` never includes a "remotes/"
  // prefix, so a remote-tracking branch (e.g. a clone with no local copy of
  // the base branch) can surface in either bucket depending on git's own
  // branch listing behavior. Matching both shapes across both arrays keeps
  // this robust to that without depending on getBranches' internal split.
  const allBranches = [...branches.local, ...branches.remote];
  const branchOk = allBranches.includes(binding.baseBranch)
    || allBranches.includes(`origin/${binding.baseBranch}`);
  if (!branchOk) {
    return { ok: false, error: `Branch "${binding.baseBranch}" was not found locally or as origin/${binding.baseBranch}.` };
  }

  for (const agentId of binding.agents ?? []) {
    if (!deps.agentExists(agentId)) {
      return { ok: false, error: `Agent "${agentId}" does not exist or is archived.` };
    }
  }

  // Format only. Main has no route to Trello (the MCP lives agent-side), so a
  // board or a list that does not exist surfaces at the first poll, named, not
  // at save time.
  if (binding.trello) {
    const trelloError = validateTrelloIntake(binding.trello);
    if (trelloError) return { ok: false, error: trelloError };
  }

  const slackError = validateSlackChannels(binding.slackChannels, otherBindings);
  if (slackError) return { ok: false, error: slackError };

  const glitchError = validateGlitchtip(binding.glitchtip, otherBindings);
  if (glitchError) return { ok: false, error: glitchError };

  const magento = binding.magentoMcpConfig?.trim();
  if (magento) {
    if (!isAbsolute(magento)) return { ok: false, error: `Magento MCP config must be an absolute path: ${magento}` };
    if (!existsSync(magento)) return { ok: false, error: `Magento MCP config file does not exist: ${magento}` };
  }

  if (deps.testJiraKey) {
    const probe = await deps.testJiraKey(binding.key);
    if (!probe.ok) {
      return { ok: false, error: `Jira project "${binding.key}" was not found (status ${probe.status ?? 'error'}).` };
    }
  }

  return { ok: true };
}

/** The project an agent BELONGS to, for the shared `project` label (registry.json /
 *  fleet.json) — as opposed to which binding CLAIMS that project's cards.
 *
 *  `agents` on a binding is a claim list, and today every binding names only its own
 *  roster (one Pam per project). Keying membership off it means every OTHER agent of
 *  the same repo falls through to the folder basename, so one floor shows up as two
 *  groups — "BRAVI" for the listed Pam and "magenio-M2-bravifarmacie" for the rest.
 *  The repo is what identifies the project, so a single enabled binding for that repo
 *  labels every agent whose main repo it is.
 *
 *  Returns null — "no opinion, use the folder name" — when the repo is not bound, or
 *  when SEVERAL bindings own it: which of them an agent is on cannot be told from the
 *  repo alone, and a wrong label is worse than a folder name. */
export function projectKeyForAgent(
  bindings: readonly JiraProjectBinding[],
  agentId: string,
  repoRoot: string | null
): string | null {
  const owned = bindings.filter((b) => b.enabled && b.repo === repoRoot);
  const claiming = owned.find((b) => !b.agents || b.agents.length === 0 || b.agents.includes(agentId));
  if (claiming) return claiming.key;
  return owned.length === 1 ? owned[0].key : null;
}

/** All configured bindings, unfiltered (enabled and disabled). */
export function listBindings(): JiraProjectBinding[] {
  return readConfig().jiraProjects ?? [];
}

/** Create or replace a binding by `key` (case-insensitive), after validating it
 *  against every OTHER binding. Rejects without writing on validation failure. */
export async function upsertBinding(
  binding: JiraProjectBinding,
  deps: JiraValidationDeps
): Promise<{ ok: true; bindings: JiraProjectBinding[] } | { ok: false; error: string }> {
  const current = listBindings();
  const others = current.filter((b) => b.key.toUpperCase() !== binding.key.toUpperCase());
  const result = await validateJiraProjectBinding(binding, others, deps);
  if (!result.ok) return result;
  const slackChannels = normalizeSlackChannels(binding.slackChannels);
  const glitchtip = normalizeGlitchtip(binding.glitchtip);
  const { slackChannels: _drop, glitchtip: _dropG, ...rest } = binding;
  const stored: JiraProjectBinding = { ...rest, ...(slackChannels.length ? { slackChannels } : {}), ...(glitchtip ? { glitchtip } : {}) };
  const next = [...others, stored];
  writeConfig({ jiraProjects: next });
  return { ok: true, bindings: next };
}

/** Remove a binding by key (case-insensitive). No-op if it doesn't exist. */
export function removeBinding(key: string): JiraProjectBinding[] {
  const k = key.trim().toUpperCase();
  const next = listBindings().filter((b) => b.key.toUpperCase() !== k);
  writeConfig({ jiraProjects: next });
  return next;
}

/** The project a Slack channel belongs to (binding first; legacy
 *  <harnessHome>/hive/slack-channels.json only until the migration latch is set); null = unmapped. */
export function slackProjectFor(channel: string): string | null {
  const cfg = readConfig();
  let legacy: Record<string, string> = {};
  try {
    // Once the one-shot import has run, the bindings are the only source of truth.
    if (cfg.harnessHome && !cfg.slackChannelsImported) legacy = parseSlackChannelsJson(readFileSync(join(expandTilde(cfg.harnessHome), 'hive', 'slack-channels.json'), 'utf8'));
  } catch { /* no legacy file */ }
  return resolveSlackProject(cfg.jiraProjects, channel, legacy);
}

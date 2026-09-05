/**
 * Jira project binding validation + config-backed CRUD (main process).
 *
 * Async validation is dependency-injected (isRepo/getBranches/agentExists/
 * testJiraKey) the same way integrationBroker.ts injects getRecord/getSecret —
 * so this stays unit-testable with fakes AND with the real git.ts helpers
 * against throwaway repos (see test/jira-projects-validate.test.cjs).
 */
import { existsSync } from 'node:fs';
import {
  type JiraProjectBinding,
  validateJiraKeyFormat,
  hasDuplicateKey
} from '../shared/jiraProjects';
import { validateTrelloIntake } from '../shared/trelloIntake';
import { readConfig, writeConfig } from './config';

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

  if (deps.testJiraKey) {
    const probe = await deps.testJiraKey(binding.key);
    if (!probe.ok) {
      return { ok: false, error: `Jira project "${binding.key}" was not found (status ${probe.status ?? 'error'}).` };
    }
  }

  return { ok: true };
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
  const next = [...others, binding];
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

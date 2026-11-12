/**
 * Codex agent shell permissions (config.json `codexSandbox`).
 *
 * Auto mode spawns codex with `-a never -s workspace-write` (agentProvider.ts):
 * writes confined to cwd + --add-dir roots, network OFF. Everything here is
 * opt-in; an absent/empty block yields no extra args, i.e. today's behaviour.
 * Pure (no imports) so the arg construction is unit-testable.
 */
export interface CodexSandboxConfig {
  /** `-c sandbox_workspace_write.network_access=true` — outbound network + loopback. */
  networkAccess?: boolean;
  /** Extra absolute dirs the shell may write (each becomes `--add-dir`). */
  extraWritableDirs?: string[];
  /** `-s danger-full-access`: NO OS sandbox at all. UI shows an explicit warning. */
  dangerFullAccess?: boolean;
  /** Per-agent overrides keyed by the HIVE AGENT ID (exact match, e.g. `god` for
   *  the orchestrator). Lets ONE agent (the orchestrator that talks to Slack /
   *  Bitbucket) get network while the rest of the floor stays offline.
   *  Keyed by id, not display name: a spawn-request can pick any `name`, but its
   *  id is always `worker-<reqId>`, and ephemeral workers never get overrides.
   *  Danger mode is deliberately NOT overridable per agent. */
  perAgent?: Record<string, CodexSandboxAgentOverride>;
}

/** What a single agent may change. `networkAccess` replaces the global value
 *  (true or false); `extraWritableDirs` is added to the global list. */
export interface CodexSandboxAgentOverride {
  networkAccess?: boolean;
  extraWritableDirs?: string[];
}

/** Effective sandbox config for one agent: the global block with that agent's
 *  override applied and `perAgent` stripped. Unknown id / no map / ephemeral
 *  worker → the global block unchanged (today's behaviour). */
export function codexSandboxForAgent(cfg: CodexSandboxConfig | undefined, agentId: string | undefined): CodexSandboxConfig | undefined {
  if (!cfg) return cfg;
  const { perAgent, ...base } = cfg;
  if (!perAgent || typeof agentId !== 'string' || !agentId || agentId.startsWith('worker-')) return base;
  const hit = Object.prototype.hasOwnProperty.call(perAgent, agentId) ? perAgent[agentId] : undefined;
  if (!hit || typeof hit !== 'object') return base;
  const out: CodexSandboxConfig = { ...base };
  if (typeof hit.networkAccess === 'boolean') out.networkAccess = hit.networkAccess;
  const dirs = Array.isArray(hit.extraWritableDirs) ? hit.extraWritableDirs.filter((d): d is string => typeof d === 'string') : [];
  if (dirs.length) out.extraWritableDirs = [...(base.extraWritableDirs ?? []), ...dirs];
  return out;
}

/** Extra spawn args for a codex agent. Danger mode needs none here: the sandbox
 *  flag is swapped in the command by `withCodexSandboxMode`. */
export function codexSandboxArgs(cfg?: CodexSandboxConfig): string[] {
  if (!cfg || cfg.dangerFullAccess) return [];
  const out: string[] = [];
  if (cfg.networkAccess === true) out.push('-c', 'sandbox_workspace_write.network_access=true');
  for (const d of cfg.extraWritableDirs ?? []) {
    if (typeof d === 'string' && d.trim()) out.push('--add-dir', d.trim());
  }
  return out;
}

/** Swap `-s workspace-write` for `-s danger-full-access` when danger mode is on.
 *  Only touches that exact pair, so a user-chosen posture is left alone. */
export function withCodexSandboxMode(args: string[], cfg?: CodexSandboxConfig): string[] {
  if (!cfg?.dangerFullAccess) return args;
  return args.map((a, i) => (a === 'workspace-write' && (args[i - 1] === '-s' || args[i - 1] === '--sandbox') ? 'danger-full-access' : a));
}

/** Same swap for a flat command string (the renderer bakes `-s workspace-write` into it). */
export function withCodexSandboxCommand(command: string, cfg?: CodexSandboxConfig): string {
  if (!cfg?.dangerFullAccess) return command;
  return command.replace(/(^|\s)(-s|--sandbox)(\s+)workspace-write(?=\s|$)/g, '$1$2$3danger-full-access');
}

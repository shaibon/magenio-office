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

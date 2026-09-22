/**
 * Magento production MCP — per-project scoping helpers (main process, electron-free).
 *
 * One magento-mcp process serves ONE project (`--config <file>`). The config path
 * lives on the Jira project binding; an agent gets only ITS project's file, and
 * every agent is denied reading every project's config (and the SSH keys they
 * reference) — the MCP process is launched by Claude Code outside the Bash
 * sandbox, so it can still read them.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { JiraProjectBinding } from '../shared/jiraProjects';

/** Default home of the per-client config files (magento-mcp README, setup step 1). */
export const MAGENTO_CONFIG_DIR = join(homedir(), '.config', 'magenio');

/** The config path of the project this agent is bound to, or undefined (fail closed:
 *  no project, disabled binding, or a project without a config → no server). */
export function magentoConfigForProject(
  project: string | undefined,
  bindings: JiraProjectBinding[] | undefined
): string | undefined {
  if (!project) return undefined;
  const b = (bindings ?? []).find((x) => x.enabled && x.key.toUpperCase() === project.toUpperCase());
  return b?.magentoMcpConfig?.trim() || undefined;
}

const expand = (p: string): string => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p);

/** Absolute paths agents must not read: the magenio config dir, every bound
 *  project's config file, and every `ssh.privateKey` those files reference. */
export function magentoDeniedReadPaths(
  bindings: JiraProjectBinding[] | undefined,
  readText: (p: string) => string = (p) => readFileSync(p, 'utf8')
): string[] {
  const out = new Set<string>([MAGENTO_CONFIG_DIR]);
  // Configs not (yet) bound to a project still name keys worth denying.
  let unbound: string[] = [];
  try { unbound = readdirSync(MAGENTO_CONFIG_DIR).filter((f) => f.endsWith('.json')).map((f) => join(MAGENTO_CONFIG_DIR, f)); } catch { /* no dir */ }
  const cfgs = [...(bindings ?? []).map((b) => b.magentoMcpConfig?.trim()), ...unbound];
  for (const cfg of cfgs) {
    if (!cfg) continue;
    out.add(cfg);
    try {
      const key = JSON.parse(readText(cfg))?.ssh?.privateKey;
      if (typeof key === 'string' && key.trim()) out.add(expand(key.trim()));
    } catch { /* unreadable/invalid config: the file itself is still denied */ }
  }
  return [...out];
}

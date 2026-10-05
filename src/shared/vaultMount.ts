/**
 * What the read-only `munder-vault` MCP server is allowed to see, for one agent.
 * Pure, so the rule is testable without electron or a vault on disk.
 */

/** Vault areas every project agent may read, beside its own project folder. */
export const VAULT_SHARED_FOLDERS = ['99-System', '03-Resources'] as const;

/** Resolved by the caller (main/index.ts) from the vault-sync project mapping. */
export interface VaultMount {
  /** Absolute vault directory. */
  root: string;
  /** Folders relative to `root`: the project folder first, then the shared ones. */
  scopes: string[];
  /** Absolute path of resources/vault-mcp.cjs. */
  script: string;
  /** Present only for the project's own writer agent (config allow-list). */
  write?: { agentId: string; lockPath: string };
}

/** A mapping's `vaultFolder` is user-typed config. Accept only a plain relative
 *  path (no `..`, no dot-segments, not absolute) so a bad mapping cannot widen the
 *  server's reach; the server re-checks the real path against the vault root. */
export function vaultScopesFor(vaultFolder: string | undefined | null): string[] | null {
  const raw = (vaultFolder ?? '').trim().replace(/\/+$/, '');
  if (!raw || raw.startsWith('/') || raw.includes('\\') || raw.includes('\0')) return null;
  const segs = raw.split('/');
  if (segs.some((s) => !s || s === '.' || s.startsWith('.'))) return null;
  return [raw, ...VAULT_SHARED_FOLDERS.filter((f) => f !== raw)];
}

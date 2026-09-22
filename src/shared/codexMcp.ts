/**
 * Codex MCP defaults (t-065) — the codex-side twin of the `mcp.json` the Claude
 * path writes.
 *
 * Codex takes external MCP servers from `mcp_servers` tables in its own
 * `config.toml`: there is no `--mcp-config` equivalent, and the Claude-shaped
 * `--settings` file does not exist for it at all (verified against
 * codex-cli 0.155.1 on this machine — that is exactly the shape `codex mcp list`
 * prints, and it is what the user's own `~/.codex/config.toml` already uses for
 * its hand-configured servers). The hive already points every codex worker at a
 * PER-AGENT `CODEX_HOME` (`<agent dir>/.codex`, seeded from the user's own
 * config.toml and extended with our lifecycle hooks), so the servers ride in that
 * same file, with the same `munder-*` names, from the same
 * `buildDefaultMcpServers()` map the Claude path serializes to JSON — one source
 * of truth for consent, enablement, per-project scoping and fail-closed
 * behaviour, so the two providers cannot drift.
 *
 * Pure and electron-free, so the spawn path and the unit tests share it.
 */
import { mcpCatalogEntry } from './mcpCatalog';

/** One server as it appears under `[mcp_servers.<name>]`. */
export interface CodexMcpServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Namespace every catalog id carries, same as the Claude path. */
const MANAGED_PREFIX = 'munder-';

/**
 * The subset of the Claude-side map a CODEX agent may hold.
 *
 * Everything is shared except one guard. The `write` tier (Trello today) is only
 * safe where the Claude path's PreToolUse allow-list enforces it (t-056) — codex
 * has no equivalent hook-side enforcement, so a NON-god codex agent never
 * receives a write-capable server: fail closed rather than hand out a server
 * whose safety mechanism does not exist on this provider. This is the same
 * reasoning `buildDefaultMcpServers` already applies to its role path, which is
 * likewise restricted to `provider === 'claude'` ("a provider that cannot enforce
 * the block never receives the server").
 *
 * The `secret` tier is deliberately NOT withheld: Magento is read-only by
 * construction and scoped per project, which is what its own `--config` argument
 * and the per-project binding do.
 */
export function codexMcpServers(
  servers: Record<string, CodexMcpServer>,
  opts: { isGod?: boolean } = {}
): Record<string, CodexMcpServer> {
  const out: Record<string, CodexMcpServer> = {};
  for (const [name, spec] of Object.entries(servers)) {
    const id = name.startsWith(MANAGED_PREFIX) ? name.slice(MANAGED_PREFIX.length) : name;
    if (!opts.isGod && mcpCatalogEntry(id)?.tier === 'write') continue;
    out[name] = spec;
  }
  return out;
}

/** A TOML key: bare when it already is one (`munder-time`), quoted otherwise.
 *  Hyphens are legal in a bare TOML key, and codex's own output is unquoted
 *  (`[mcp_servers.node_repl]`), but a dotted or spaced id from a future catalog
 *  entry must not silently produce an unparseable file. */
function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

/**
 * Render the `[mcp_servers.*]` tables for a codex `config.toml`, or '' when there
 * is nothing to add (so a plain worker's config is byte-identical to before).
 *
 * Strings and arrays go through JSON.stringify: a JSON string is also a valid
 * TOML basic string and a JSON array of strings is a valid TOML inline array, and
 * it escapes the quotes a hive path containing spaces needs. `env` values are
 * therefore always strings — codex's schema wants strings there, and the catalog
 * already declares empty-string placeholders for servers awaiting a key.
 */
export function codexMcpToml(servers: Record<string, CodexMcpServer>): string {
  const names = Object.keys(servers);
  if (!names.length) return '';
  let out = '\n# --- munder-hive default MCP servers (auto-generated; do not edit) ---\n';
  for (const name of names) {
    const s = servers[name];
    const key = tomlKey(name);
    out += `\n[mcp_servers.${key}]\ncommand = ${JSON.stringify(s.command)}\nargs = ${JSON.stringify(s.args ?? [])}\n`;
    const env = Object.entries(s.env ?? {});
    if (env.length) {
      out += `\n[mcp_servers.${key}.env]\n`;
      for (const [k, v] of env) out += `${tomlKey(k)} = ${JSON.stringify(v)}\n`;
    }
  }
  return out;
}

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

/** Catalog ids withheld from a NON-god codex agent regardless of tier — servers
 *  whose tools reach outside the codex sandbox. Kept as a named list so the rule
 *  is one place to read and one place to extend.
 *
 *  `fetch` sends an arbitrary URL; `context7` queries an external documentation
 *  API with free-text. Both are egress, and once t-070 pre-approves a server's
 *  tools, an injected instruction can carry data out through either with nobody
 *  to see it. The discriminator: does the tool put caller-supplied TEXT on the
 *  wire to something we do not control? Our filesystem/git servers do not
 *  (cwd-scoped), and magento reaches one project's store, read-only by
 *  construction. */
const NON_GOD_CODEX_WITHHELD = new Set(['fetch', 'context7']);

/**
 * The subset of the Claude-side map a CODEX agent may hold.
 *
 * Everything is shared except two guards, both fail-closed on the provider that
 * cannot enforce them. The `write` tier (Trello today) is only safe where the
 * Claude path's PreToolUse allow-list enforces it (t-056) — codex has no
 * equivalent hook-side enforcement, so a NON-god codex agent never receives a
 * write-capable server. This is the same reasoning `buildDefaultMcpServers`
 * already applies to its role path, which is likewise restricted to
 * `provider === 'claude'` ("a provider that cannot enforce the block never
 * receives the server").
 *
 * The servers in NON_GOD_CODEX_WITHHELD are withheld for the same class of
 * reason (t-070 review): they are network egress the codex sandbox does not
 * cover, and t-070 pre-approves our servers' tools, so one prompt injection
 * turns such a call into an exfiltration channel with no human in the loop —
 * precisely the control the Claude path has (its PreToolUse allow-list and
 * permission prompts) and codex does not.
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
    if (!opts.isGod && (mcpCatalogEntry(id)?.tier === 'write' || NON_GOD_CODEX_WITHHELD.has(id))) continue;
    out[name] = spec;
  }
  return out;
}

/** The only codex MCP approval mode that never waits for a human (t-070). */
const PREAPPROVED_TOOLS_MODE = 'approve';

/**
 * t-070 — an MCP tool that "requires approval" is a DEAD tool in this hive.
 *
 * Every codex worker is spawned unattended with `-a never` (`approval_policy =
 * "never"`, agentProvider.ts). In that combination a tool whose effective mode is
 * anything but pre-approved does not prompt — it FAILS, with "MCP tool call
 * requires approval, but approval policy is never". So mounting a server without
 * pre-approving its tools is half a mount: Dwight BURD could see `munder_magento`
 * and no call ever worked.
 *
 * The mode is set per SERVER, inside our own `[mcp_servers.*]` tables, and only
 * for the tables this function generates: the user's own servers keep codex's
 * default, and the global `approval_policy` is never touched — changing it would
 * alter the user's own Codex sessions and every other server they run.
 *
 * The key and its accepted values are the binary's own, not a guess: on
 * codex-cli 0.155.1 a bogus value fails with "unknown variant `zzz`, expected one
 * of `auto`, `prompt`, `writes`, `approve` in
 * `mcp_servers.<name>.default_tools_approval_mode`" (`codex mcp list`), and all
 * four real values load cleanly. `approve` is the only one that never waits.
 *
 * The `write` tier (Trello) is deliberately LEFT OUT: the codex path has no
 * PreToolUse allow-list, so codex's own gating is the only control on those write
 * tools (t-065 withholds them from a non-god codex agent for the same reason).
 * Pre-approving them would erase it. Consequence, on purpose: on a codex agent
 * Trello's tools stay uncallable until someone decides otherwise.
 */
function approvalModeLine(name: string): string {
  const id = name.startsWith(MANAGED_PREFIX) ? name.slice(MANAGED_PREFIX.length) : name;
  if (mcpCatalogEntry(id)?.tier === 'write') return '';
  return `default_tools_approval_mode = ${JSON.stringify(PREAPPROVED_TOOLS_MODE)}\n`;
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
    // t-070: without a pre-approval the tools of a mounted server are uncallable
    // on the unattended codex path (see approvalModeLine). Before the env sub-table,
    // so the key lands in the server's own table.
    out += approvalModeLine(name);
    const env = Object.entries(s.env ?? {});
    if (env.length) {
      out += `\n[mcp_servers.${key}.env]\n`;
      for (const [k, v] of env) out += `${tomlKey(k)} = ${JSON.stringify(v)}\n`;
    }
  }
  return out;
}

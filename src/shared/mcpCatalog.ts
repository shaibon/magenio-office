/**
 * Default MCP server catalog (Workstream 3). A dependency-free, importable-by-both
 * (main + renderer) registry of the MCP servers Munder Difflin can wire into each
 * agent's per-session `settings.json`. Keep it free of electron/UI/node imports.
 *
 * Tiers gate consent:
 *   - 'safe-readonly' → no secret, no destructive write OUTSIDE the agent cwd; shipped
 *                       ON by default (`defaultEnabled:true`). `filesystem`/`git` are
 *                       scoped to the agent cwd at merge time (never whole-disk).
 *   - 'write'         → can mutate state beyond the workspace; OFF by default,
 *                       consent-gated.
 *   - 'secret'        → needs an API key / token / connection string; OFF by default,
 *                       consent-gated.
 *
 * The actual merge (catalog ∩ enabled, cwd-scoping of filesystem/git, id namespacing,
 * non-fatal resolution) is Workstream 3's `buildDefaultMcpServers`/`hookSettings`
 * job — this module only declares the entries, their tiers, and the seed defaults.
 *
 * NOTE: several reference servers ship as Python (uvx) rather than npm (npx). The
 * commands below reflect each server's real transport; entries that couldn't be
 * verified against an installed server are flagged `// TODO-verify`. Workstream 3
 * makes a server that fails to resolve non-fatal to the agent.
 */

export type McpTier = 'safe-readonly' | 'write' | 'secret';

export interface McpCatalogEntry {
  /** Stable catalog id (also the consent key in `config.mcpDefaults`). The merge
   *  step namespaces the written server id (e.g. `munder-<id>`) to avoid clobbering
   *  a user's own `~/.claude` MCP server of the same name. */
  id: string;
  /** Human label for the consent UI. */
  label: string;
  /** One-line description for the consent UI / hire import preview. */
  description: string;
  /** The MCP stdio server launch spec. `filesystem`/`git` carry a placeholder cwd
   *  arg that Workstream 3 replaces with the agent cwd at merge time. */
  spec: {
    command: string;
    args: string[];
    /** Required env (e.g. an API token). Present only on write/secret entries; the
     *  value is supplied via consent, never hard-coded here. */
    env?: Record<string, string>;
  };
  tier: McpTier;
  /** The launch command is NOT distributable (a local server, an absolute path,
   *  the user's own build): `spec` is a placeholder and the real values come
   *  from `config.mcpDefaults[id].command/args`. */
  userConfigured?: boolean;
  /** Seed for `config.mcpDefaults[id].enabled`. Always === (tier === 'safe-readonly'). */
  defaultEnabled: boolean;
  /** Seed for `config.mcpDefaults[id].agents` — the per-agent allow-list this
   *  server ships restricted to. Absent means "no restriction by default",
   *  which the merge step reads as every agent (today's behaviour for every
   *  entry that has always shipped without one).
   *
   *  It lives HERE, next to the tier and the description, because it is the
   *  entry's security posture and a reader looking at the entry must be able
   *  to see it. A server whose tools are only safe in one agent's hands (the
   *  Trello server exposes `create_board`/`archive_list`/`update_card_details`,
   *  and only god's mission carries the never-write-to-Trello discipline) is
   *  restricted from its first materialization, not from the moment the user
   *  remembers to type an allow-list. */
  defaultAgents?: string[];
}

/** One server's consent entry as it is stored in `config.mcpDefaults[id]`. */
export interface McpConsentEntry {
  enabled: boolean;
  agents?: string[];
  command?: string;
  args?: string[];
}

/** Upstream repo of the Trello MCP server the installer clones, and the TAG it
 *  is pinned to. Pinned deliberately: the app builds this third-party code and
 *  runs it inside its own agents, so a moving `main` would mean two installs
 *  are not the same software. Raising this tag is a reviewable code change. */
export const TRELLO_MCP_REPO_URL = 'https://github.com/delorenj/mcp-server-trello.git';
export const TRELLO_MCP_TAG = 'v1.8.1';

/** The default MCP bundle. Safe/read-only servers are ON; anything that writes
 *  beyond the workspace or needs a secret is OFF until the user consents. */
export const MCP_CATALOG: McpCatalogEntry[] = [
  // ─── Safe, read-only, no-secret — shipped ON ──────────────────────────────
  {
    id: 'sequential-thinking',
    label: 'Sequential Thinking',
    description: 'Structured step-by-step reasoning scratchpad. No I/O, no secrets.',
    spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
    tier: 'safe-readonly',
    defaultEnabled: true
  },
  {
    id: 'time',
    label: 'Time',
    description: 'Current time and timezone conversions.',
    // Reference time server ships as Python. // TODO-verify transport (uvx vs an npm port)
    spec: { command: 'uvx', args: ['mcp-server-time'] },
    tier: 'safe-readonly',
    defaultEnabled: true
  },
  {
    id: 'fetch',
    label: 'Fetch',
    description: 'Fetch a URL and return its content as markdown (read-only HTTP GET).',
    // Reference fetch server ships as Python. // TODO-verify transport (uvx vs an npm port)
    spec: { command: 'uvx', args: ['mcp-server-fetch'] },
    tier: 'safe-readonly',
    defaultEnabled: true
  },
  {
    id: 'context7',
    label: 'Context7 Docs',
    description: 'Up-to-date library/framework documentation lookups.',
    spec: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
    tier: 'safe-readonly',
    defaultEnabled: true
  },
  {
    id: 'filesystem',
    label: 'Filesystem (cwd)',
    description: 'Read/edit files within the agent workspace only (scoped to cwd at spawn).',
    // The trailing arg is the allowed root — Workstream 3 replaces this placeholder
    // with the agent cwd at merge time so it is NEVER whole-disk.
    spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '<cwd>'] },
    tier: 'safe-readonly',
    defaultEnabled: true
  },
  {
    id: 'git',
    label: 'Git (cwd)',
    description: 'Inspect git status/log/diff for the workspace repo (scoped to cwd at spawn).',
    // Reference git server ships as Python; `--repository <cwd>` is set at merge time.
    // TODO-verify transport (uvx vs an npm port).
    spec: { command: 'uvx', args: ['mcp-server-git', '--repository', '<cwd>'] },
    tier: 'safe-readonly',
    defaultEnabled: true
  },

  // ─── Write / secret — shipped OFF, consent-gated ──────────────────────────
  {
    id: 'github-token',
    label: 'GitHub',
    description: 'Read/write GitHub issues, PRs, and repos. Requires a personal access token.',
    spec: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' }
    },
    tier: 'secret',
    defaultEnabled: false
  },
  {
    id: 'db',
    label: 'Database',
    description: 'Query a SQL database. Requires a connection string.',
    // TODO-verify exact server package for the user's DB engine (Postgres assumed).
    spec: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres'],
      env: { DATABASE_URL: '' }
    },
    tier: 'secret',
    defaultEnabled: false
  },
  {
    id: 'email-calendar',
    label: 'Email & Calendar',
    description: 'Read/send mail and read/write calendar events. Requires account credentials.',
    // TODO-verify provider package (Gmail/Google Calendar assumed).
    spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-gsuite'], env: { GOOGLE_OAUTH_TOKEN: '' } },
    tier: 'secret',
    defaultEnabled: false
  },
  {
    id: 'search-with-key',
    label: 'Web Search',
    description: 'Keyed web search. Requires a search-provider API key.',
    // TODO-verify provider package (Brave Search assumed).
    spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], env: { BRAVE_API_KEY: '' } },
    tier: 'secret',
    defaultEnabled: false
  },
  {
    id: 'trello',
    label: 'Trello (read-only intake)',
    description: 'Reads Trello boards, lists and cards for the Trello→Jira intake poll. You supply the launch command; the server holds its own credentials in its .env.',
    // Placeholder: userConfigured entries take command/args from the consent map.
    spec: { command: '', args: [] },
    tier: 'write',
    defaultEnabled: false,
    userConfigured: true,
    // Spec decision 7: Trello access is "ristretto a un insieme esplicito di
    // agenti … oggi ['god']". god's mission is the only place the never-write
    // discipline is written down, so no other agent may hold these tools.
    defaultAgents: ['god']
  }
];

/** Look up a catalog entry by id. */
export function mcpCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((e) => e.id === id);
}

/** Whether an id is a known safe-readonly server (the only tier a hire manifest may
 *  request without surfacing for human consent — Workstream 3 validation). */
export function isSafeReadonlyMcp(id: string): boolean {
  return mcpCatalogEntry(id)?.tier === 'safe-readonly';
}

/** Seed for `DEFAULTS.mcpDefaults` — derived from the catalog so the two never
 *  drift (safe-readonly ON, write/secret OFF, `defaultAgents` applied). */
export function defaultMcpDefaults(): Record<string, McpConsentEntry> {
  const out: Record<string, McpConsentEntry> = {};
  for (const e of MCP_CATALOG) out[e.id] = seedMcpConsent(e.id);
  return out;
}

/** The consent entry to start from for `id` when the config has none yet. */
export function seedMcpConsent(id: string): McpConsentEntry {
  const entry = mcpCatalogEntry(id);
  return {
    enabled: entry?.defaultEnabled ?? false,
    ...(entry?.defaultAgents?.length ? { agents: [...entry.defaultAgents] } : {})
  };
}

/**
 * Merge `patch` into the stored consent for `id`, materializing the entry when
 * there is none — the single place a `config.mcpDefaults[id]` value is ever
 * built, so the catalog's `defaultAgents` allow-list cannot be lost by writing
 * through some other path.
 *
 * ABSENT ≠ EMPTY. A missing `agents` key means "the user has never expressed a
 * choice" and takes the catalog default. An `agents: []` that is actually
 * present is the user's deliberate "every agent" choice (that is precisely
 * what the Agents field writes when they clear it) and is NEVER re-seeded — a
 * later Install or toggle must not quietly re-narrow a list they widened on
 * purpose.
 */
export function mergeMcpConsent(
  id: string,
  existing: McpConsentEntry | undefined,
  patch: Partial<McpConsentEntry>
): McpConsentEntry {
  const seed = seedMcpConsent(id);
  const merged: McpConsentEntry = { ...seed, ...existing, ...patch };
  // An explicit `agents: undefined` is not a user choice — JSON cannot express
  // it and only a caller spreading a partial can produce it. Treat it as absent
  // (fall back to the seed) rather than as "every agent".
  if (merged.agents === undefined) {
    if (seed.agents) merged.agents = [...seed.agents];
    else delete merged.agents;
  }
  return merged;
}

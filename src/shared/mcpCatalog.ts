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
    /** Required env (e.g. an API token). An empty value names a variable that
     *  must be present in Munder's environment; its value is never stored here. */
    env?: Record<string, string>;
  };
  tier: McpTier;
  /** The launch command is NOT distributable (a local server, an absolute path,
   *  the user's own build): `spec` is a placeholder and the real values come
   *  from `config.mcpDefaults[id].command/args`. */
  userConfigured?: boolean;
  /** A remote (HTTP) server rather than a local process: `config.mcpDefaults[id].url`
   *  is the endpoint and a write-only bearer token lives in the encrypted secret
   *  store under `N8N_SECRET_REF`. Mounted natively as
   *  `type: http` for Claude and `url` + `env_http_headers` for Codex, pointed at the
   *  loopback broker's `/n8n-mcp` route (which adds the bearer). `spec` is unused. */
  remote?: boolean;
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
  /** Like `defaultAgents` but by ROLE (see `isPmRole`), not by agent id —
   *  survives a restore where ids change. Additive to `defaultAgents`: either
   *  match is enough to include the agent. */
  defaultRoles?: string[];
}

/** One server's consent entry as it is stored in `config.mcpDefaults[id]`. */
export interface McpConsentEntry {
  enabled: boolean;
  agents?: string[];
  /** Role-based counterpart to `agents` (see `McpCatalogEntry.defaultRoles`). */
  roles?: string[];
  command?: string;
  args?: string[];
  /** Legacy single global n8n endpoint; `migrateN8nConsent` folds it into `projects`. */
  url?: string;
  /** Per-project n8n endpoints (`remote` entry), keyed by project (the key agents carry
   *  as `project`). Each has its own allow-list; its bearer is in the secret store under
   *  `n8nSecretRef(project)`. */
  projects?: Record<string, N8nProjectEntry>;
}

export interface N8nProjectEntry {
  /** n8n MCP endpoint (non-secret). */
  url?: string;
  agents?: string[];
}

/** Secret-store handle of a project's n8n MCP bearer token (same encrypted store as
 *  the integrations' `int:<id>` secrets, but a distinct namespace). */
export const n8nSecretRef = (project: string): string => `mcp:n8n:${project}`;
/** Outcome of a live token check against the project's n8n MCP endpoint. */
export type N8nTokenCheck = 'valid' | 'invalid' | 'unreachable';
/** The JSON-RPC 2.0 reply carried by `body` (plain JSON, or the first parsable SSE `data:` frame). */
export const jsonRpcReply = (body: string | undefined): { result?: unknown; error?: { code?: unknown; message?: unknown } } | undefined => {
  const t = (body ?? '').trim();
  for (const f of t.startsWith('{') ? [t] : t.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5))) {
    try { const j = JSON.parse(f); if (j?.jsonrpc === '2.0' && j.id === 1) return j; } catch { /* next frame */ }
  }
  return undefined;
};
/** HTTP status + body of the MCP initialize probe (status null = network error / timeout) ->
 *  outcome: 2xx WITH a successful initialize reply valid; 401/403, or a 2xx JSON-RPC error that
 *  reads as an auth failure, invalid; anything else (a 2xx that is not MCP, other JSON-RPC
 *  errors, 5xx, redirects, other 4xx) unreachable. */
export const classifyN8nTokenCheck = (status: number | null, body?: string): N8nTokenCheck => {
  if (status === 401 || status === 403) return 'invalid';
  if (status === null || status < 200 || status >= 300) return 'unreachable';
  const r = jsonRpcReply(body);
  if (r?.error === undefined && typeof (r?.result as { protocolVersion?: unknown } | undefined)?.protocolVersion === 'string' && (r!.result as { protocolVersion: string }).protocolVersion !== '') return 'valid';
  return r?.error && (r.error.code === 401 || r.error.code === 403 || /unauthori[sz]ed|forbidden|invalid.*token|authenticat/i.test(String(r.error.message ?? ''))) ? 'invalid' : 'unreachable';
};

/** Pre-per-project global handle; only read by the migration. */
export const N8N_LEGACY_SECRET_REF = 'mcp:n8n';

/** A project key safe to use in a secret ref and as a config key. */
export const isN8nProjectKey = (p: unknown): p is string =>
  typeof p === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(p) && !(p in Object.prototype); // constructor, toString, ...

/** The n8n upstream config for `agentId` of `project`, or null (fail closed): the
 *  server must be enabled, the project must have its OWN entry with a valid URL, and
 *  the agent must be on that entry's list (empty/absent list = nobody). */
export function resolveN8nProject(
  consent: McpConsentEntry | undefined,
  project: string | undefined,
  agentId: string
): { url: string } | null {
  if (!consent?.enabled || !isN8nProjectKey(project)) return null;
  const e = Object.prototype.hasOwnProperty.call(consent.projects ?? {}, project) ? consent.projects![project] : undefined;
  const url = normalizeN8nUrl(e?.url);
  return url && e?.agents?.includes(agentId) ? { url } : null;
}

/** Fold a legacy global `{url, agents}` n8n consent into per-project entries, using
 *  `projectOf` to place each allow-listed agent; agents with no known project are
 *  dropped (fail closed). Returns null when there is nothing legacy to migrate. */
export function migrateN8nConsent(
  consent: McpConsentEntry | undefined,
  projectOf: (agentId: string) => string | undefined
): { consent: McpConsentEntry; projects: string[] } | null {
  if (!consent || (consent.url === undefined && !('agents' in consent))) return null;
  const { url, agents, ...rest } = consent;
  const projects: Record<string, N8nProjectEntry> = { ...(consent.projects ?? {}) };
  const moved: string[] = [];
  if (url) {
    for (const a of agents ?? []) {
      const p = projectOf(a);
      if (!isN8nProjectKey(p) || Object.prototype.hasOwnProperty.call(projects, p)) continue;
      projects[p] = { url, agents: (agents ?? []).filter((x) => projectOf(x) === p) };
      moved.push(p);
    }
  }
  return { consent: { ...rest, projects }, projects: moved };
}

/** Run the legacy-global -> per-project migration so a failure never loses the bearer:
 *  copy the legacy secret to each new project (never overwriting an existing one),
 *  persist the config, and only then delete the legacy secret. Any failure rolls the
 *  new secrets back and leaves everything as it was (retried at the next startup). */
export function runN8nMigration(deps: {
  consent: McpConsentEntry | undefined;
  projectOf: (agentId: string) => string | undefined;
  getLegacy: () => string | undefined;
  hasSecret: (ref: string) => boolean;
  setSecret: (ref: string, v: string) => { ok: boolean };
  deleteSecret: (ref: string) => boolean;
  writeConsent: (c: McpConsentEntry) => void;
}): { migrated: boolean; projects: string[] } {
  const m = migrateN8nConsent(deps.consent, deps.projectOf);
  if (!m) {
    // Nothing left to migrate, but a previous run may have written the config and failed
    // to delete the legacy secret: finish that cleanup (the legacy ref is no longer used).
    if (deps.hasSecret(N8N_LEGACY_SECRET_REF) && !deps.deleteSecret(N8N_LEGACY_SECRET_REF))
      throw new Error('the legacy n8n token could not be removed');
    return { migrated: false, projects: [] };
  }
  const legacy = deps.getLegacy();
  // A stored but unreadable legacy token (decryption unavailable): keep the global config
  // untouched and retry at the next start instead of migrating with no bearer.
  if (!legacy && deps.hasSecret(N8N_LEGACY_SECRET_REF)) throw new Error('the legacy n8n token is stored but cannot be read');
  const created: string[] = [];
  const rollback = () => { for (const p of created) deps.deleteSecret(n8nSecretRef(p)); };
  try {
    if (legacy) {
      for (const p of m.projects) {
        if (deps.hasSecret(n8nSecretRef(p))) continue;
        if (!deps.setSecret(n8nSecretRef(p), legacy).ok) throw new Error(`could not store the n8n token for ${p}`);
        created.push(p);
      }
    }
    deps.writeConsent(m.consent);
  } catch (e) {
    rollback();
    throw e;
  }
  if (legacy && !deps.deleteSecret(N8N_LEGACY_SECRET_REF)) throw new Error('migrated, but the legacy n8n token could not be removed (retried at next start)');
  return { migrated: true, projects: m.projects };
}

/** Env var carrying an allowed agent's n8n-route broker capability, and the header
 *  the agent's MCP config sends it in (value `${N8N_BROKER_TOKEN_ENV}`, expanded by
 *  Claude / codex at connect time). */
export const N8N_BROKER_TOKEN_ENV = 'MD_N8N_MCP_TOKEN';
export const BROKER_TOKEN_HEADER = 'X-MD-Broker-Token';

/** Validate an n8n MCP endpoint: https (http only for a loopback dev instance),
 *  no userinfo. Returns the normalized URL, or null. */
export function normalizeN8nUrl(raw: string | undefined | null): string | null {
  try {
    const u = new URL(String(raw ?? '').trim());
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** The READ-ONLY tools of the pinned Trello MCP server build
 *  (`bun .../magenio-mcp/trello-mcp/build/index.js`). This is an ALLOW-list, and
 *  it is the load-bearing half of the classification: the runtime guard
 *  (`HiveManager.isTrelloWriteBlocked` + the PreToolUse hook) blocks every Trello
 *  tool that is NOT named here. A write tool added to a future server build is
 *  therefore blocked the moment it appears, without anyone editing a list —
 *  which is what a hand-written deny-list could not do.
 *
 *  `download_attachment` is classified READ: it fetches a file and mutates
 *  nothing on the board (where that file lands is the agent's own sandbox's
 *  business, not Trello's). */
export const TRELLO_READ_TOOLS = [
  'download_attachment',
  'find_checklist_items_by_description',
  'get_acceptance_criteria', 'get_active_board_info', 'get_board_custom_fields',
  'get_board_labels', 'get_board_members', 'get_card', 'get_card_comments',
  'get_card_history', 'get_cards_by_list_id', 'get_checklist_by_name',
  'get_checklist_items', 'get_health', 'get_health_detailed', 'get_health_metadata',
  'get_health_performance', 'get_lists', 'get_my_cards', 'get_recent_activity',
  'list_boards', 'list_boards_in_workspace', 'list_workspaces', 'search_cards'
] as const;

/** The write-mutating tools of the same build. Kept as an explicit list
 *  because `permissions.deny` in the agent's settings file needs EXACT tool
 *  names, not glob patterns: this is the in-settings half of the block, written
 *  as `mcp__munder-trello__<name>`. The allow-list above is what makes the pair
 *  fail-closed; this list only stops the known writes before the model asks
 *  (defense in depth). */
export const TRELLO_WRITE_TOOLS = [
  'add_card_to_list', 'update_card_details', 'archive_card', 'watch_card', 'watch_list',
  'move_card', 'add_list_to_board', 'archive_list', 'update_list', 'update_list_position',
  'attach_image_to_card', 'attach_file_to_card', 'attach_data_to_card', 'attach_image_data_to_card',
  'set_active_board', 'create_board', 'set_active_workspace',
  'add_comment', 'update_comment', 'delete_comment',
  'create_checklist', 'add_checklist_item', 'update_checklist_item', 'delete_checklist_item',
  'assign_member_to_card', 'remove_member_from_card',
  'create_label', 'update_label', 'delete_label',
  'copy_card', 'copy_checklist', 'add_cards_to_list',
  'update_card_custom_field', 'perform_system_repair'
] as const;

/** Every tool `tools/list` returns for the pinned build (58 = 34 write + 24 read).
 *  The completeness set: the catalog test asserts each name is classified exactly
 *  once and — when the built server is present on this machine — that the server
 *  exposes nothing outside it, so an unclassified tool fails the suite instead of
 *  shipping silently. Raise it only together with the pin, classifying anything
 *  the new build added. */
export const TRELLO_KNOWN_TOOLS = [...TRELLO_READ_TOOLS, ...TRELLO_WRITE_TOOLS] as const;

/** The server id the agents' MCP tools are namespaced under. */
export const TRELLO_MCP_SERVER_ID = 'munder-trello';

/** The `mcp__<server>__<tool>` id Claude Code uses in settings/permission rules. */
export function trelloToolId(tool: string): string {
  return `mcp__${TRELLO_MCP_SERVER_ID}__${tool}`;
}

/** The exact-name deny list written into a non-god agent's settings.json. */
export function trelloDeniedToolIds(): string[] {
  return TRELLO_WRITE_TOOLS.map((t) => trelloToolId(t));
}

/** Is this a tool of the Trello server at all (either a namespaced id or one of
 *  the bare names this build is known to expose)? Decides whether the fail-closed
 *  policy below applies to a call. */
export function isTrelloTool(toolName: string | undefined | null): boolean {
  const name = (toolName ?? '').trim();
  if (!name) return false;
  if (name.startsWith(`mcp__${TRELLO_MCP_SERVER_ID}__`)) return true;
  return (TRELLO_KNOWN_TOOLS as readonly string[]).includes(name);
}

/** The runtime decision, fail-closed: for an agent whose Trello writes are
 *  blocked, a Trello call is allowed ONLY when it names a read tool. Anything
 *  unrecognised — a tool a newer build added, a typo, an empty name — is denied,
 *  and an empty name is denied too (no name, no read). */
export function isTrelloReadOnlyCall(toolName: string | undefined | null): boolean {
  const raw = (toolName ?? '').trim();
  if (!raw) return false;
  const prefix = `mcp__${TRELLO_MCP_SERVER_ID}__`;
  const bare = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  return (TRELLO_READ_TOOLS as readonly string[]).includes(bare);
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
    // Trello access is restricted to an explicit set of agents: the
    // orchestrator role is the only place the never-write discipline is
    // written down, so no other agent may hold these tools by default.
    defaultAgents: ['god'],
    // PMs also read Trello, by role rather than by id. Their write
    // tools are blocked at the settings layer (hookSettings' permissions.deny,
    // TRELLO_WRITE_TOOLS above) rather than by prompt discipline alone.
    defaultRoles: ['pm']
  },
  {
    id: 'magento',
    label: 'Magento production (read-only)',
    description: 'Read-only analysis of a production Magento store (logs, bin/magento, SQL SELECT, REST GET). Scoped per project: each agent sees only its own project\'s store, set as the "Magento MCP config" on the Jira project binding. You supply node + the magento-mcp dist/index.js.',
    // Placeholder: userConfigured entries take command/args from the consent map
    // (command = node, args[0] = <repo>/dist/index.js). `--config` is appended per agent.
    spec: { command: '', args: [] },
    tier: 'secret',
    defaultEnabled: false,
    userConfigured: true
  },
  {
    id: 'gsc',
    label: 'Google Search Console (read-only)',
    description: 'Read-only Search Console analytics (sites, search analytics, URL inspection, sitemaps) through the vendored mcp-gsc server with the webmasters.readonly scope. Scoped per project: each agent sees only its own project\'s property, set as the "GSC MCP key" (service-account JSON) on the Jira project binding. You supply the launcher. Recommended: command = /opt/homebrew/bin/uv, args (one per line) = run, --frozen, --no-sync, --directory, <magenio-mcp>/gsc-mcp, gsc_server.py (the directory and the script are checked). Alternative: command = <magenio-mcp>/gsc-mcp/.venv/bin/python, args = <magenio-mcp>/gsc-mcp/gsc_server.py.',
    // Placeholder: userConfigured entries take command/args from the consent map; the
    // per-agent GSC_CREDENTIALS_PATH is added at mount time.
    spec: { command: '', args: [] },
    tier: 'secret',
    defaultEnabled: false,
    userConfigured: true
  },
  {
    id: 'n8n',
    label: 'n8n (workflows)',
    description: 'Lets the listed agents search, inspect and run workflows on your n8n instance through its built-in MCP server (https://<domain>/mcp-server/http). Write-capable: only the agents named in the allow-list receive it. The bearer token is stored encrypted and is never shown to agents.',
    // Placeholder: `remote` entries take their endpoint from the consent map.
    spec: { command: '', args: [] },
    // 'secret', not 'write': the write tier is withheld from non-god codex
    // agents, and this server is meant for codex too. The safeguard is the
    // explicit enabled:true consent PLUS a mandatory non-empty agent allow-list
    // (an empty list means "nobody" here, never "everybody").
    tier: 'secret',
    defaultEnabled: false,
    remote: true
  },
  {
    id: 'vault',
    label: 'Project vault (read-only)',
    description: 'Read, list and search the notes of the agent\'s own project in the Obsidian vault, plus the shared 99-System and 03-Resources folders. Mounted only for an agent whose repo maps to a vault project (Knowledge Graph → Vault Sync); no write tools.',
    // Placeholder: the mount swaps in the bundled node, the script path and the
    // per-agent vault scope (see buildDefaultMcpServers).
    spec: { command: 'node', args: ['<vault-mcp.cjs>'] },
    tier: 'safe-readonly',
    defaultEnabled: true
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
    ...(entry?.defaultAgents?.length ? { agents: [...entry.defaultAgents] } : {}),
    ...(entry?.defaultRoles?.length ? { roles: [...entry.defaultRoles] } : {})
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
  // Same ABSENT ≠ EMPTY treatment for `roles`.
  if (merged.roles === undefined) {
    if (seed.roles) merged.roles = [...seed.roles];
    else delete merged.roles;
  }
  return merged;
}

/** A consent patch, or a function from the entry's CURRENT (persisted, at run time) state
 *  to one. Semantic edits (upsert/remove one n8n project) must use the function form so
 *  they never carry a whole `projects` map snapshotted from the optimistic view. */
export type ConsentPatch = Partial<McpConsentEntry> | ((cur: McpConsentEntry | undefined) => Partial<McpConsentEntry>);

/** Semantic n8n project edits for `createConsentWriter`. */
export const n8nProjectOps = {
  upsert: (key: string, p: N8nProjectEntry): ConsentPatch => (cur) => ({
    projects: { ...(cur?.projects ?? {}), [key]: { ...(cur?.projects?.[key] ?? {}), ...p } }
  }),
  remove: (key: string): ConsentPatch => (cur) => {
    const { [key]: _gone, ...rest } = cur?.projects ?? {};
    return { projects: rest };
  }
};

/** Remove an n8n project: FIRST a verified clear of its bearer, THEN the config entry.
 *  Clear fails -> nothing changed. Clear ok but the config write fails -> the entry is left
 *  without a token, which is fail-closed (it mounts nothing). No rollback, so nothing can
 *  overwrite an edit queued meanwhile. Returns whether the entry was removed. */
export async function removeN8nProjectFlow(
  project: string,
  clearToken: () => Promise<boolean>,
  write: (patch: ConsentPatch) => Promise<unknown>
): Promise<boolean> {
  if (!(await clearToken())) return false;
  try { await write(n8nProjectOps.remove(project)); return true; } catch { return false; }
}

/** The Settings panel's consent writer. `ref` is the optimistic view the UI reads; every
 *  write applies its patch, when it runs in the queue, to the last PERSISTED state (never
 *  to the optimistic one), so a rejected write cannot leak into a write queued behind it.
 *  After a rejection `ref` is rebuilt as persisted + the patches still pending. */
export function createConsentWriter(
  ref: { current: Record<string, McpConsentEntry> | undefined },
  update: (next: Record<string, McpConsentEntry>) => Promise<unknown>
): (id: string, patch: ConsentPatch) => Promise<unknown> {
  type Defaults = Record<string, McpConsentEntry>;
  const apply = (base: Defaults | undefined, id: string, patch: ConsentPatch): Defaults =>
    ({ ...(base ?? {}), [id]: mergeMcpConsent(id, base?.[id], typeof patch === 'function' ? patch(base?.[id]) : patch) });
  let queue: Promise<unknown> = Promise.resolve();
  let persisted: Defaults | undefined;
  const pending: Array<{ id: string; patch: ConsentPatch }> = [];
  return (id, patch) => {
    if (pending.length === 0) persisted = ref.current; // idle: the ref is the persisted truth (synced from config)
    const job = { id, patch };
    pending.push(job);
    ref.current = apply(ref.current, id, patch);
    const run = async () => {
      const merged = apply(persisted, id, patch);
      try {
        await update(merged);
        persisted = merged;
      } catch (e) {
        pending.splice(pending.indexOf(job), 1);
        ref.current = pending.reduce((acc, j) => apply(acc, j.id, j.patch), persisted);
        throw e;
      }
      pending.splice(pending.indexOf(job), 1);
    };
    const result = queue.then(run, run);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
}

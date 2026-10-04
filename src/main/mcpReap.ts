/**
 * Reaping the MCP servers an agent session leaves behind.
 *
 * Measured live 2026-09-23, and it corrects an assumption worth stating because
 * a group-based design leans on it: killing the session's process GROUP does not
 * reach its MCP servers. There are TWO setsid levels, not one.
 *
 *   93737 Electron                  pgid 93713
 *     97700 codex resume …          pgid 97700  <- the session is its own group
 *       832 node magento-mcp …      pgid 832    <- …and so is the MCP server
 *
 * procKill.ts is built on the first level: the pty child is a session leader, so
 * `kill(-pid)` sweeps its descendants. That is true for the agent's OWN tree (a
 * dev server it started, a shell it left open) and is already wired. What it
 * cannot reach is the second level: claude and codex spawn their stdio MCP
 * servers DETACHED, each into its own process group and session, so the group
 * sweep walks straight past them. When the session dies they are reparented to
 * PID 1 and run forever — 85 of them on this floor, ~460 MB, 82 one single
 * `trello-mcp`, the oldest alive 13h34 across five app restarts. The magento one
 * still carries `--config …/burd.json` in its argv: a process authorized by a
 * session, outliving that session.
 *
 * So the reaper cannot work by process group; it has to work by IDENTITY, and
 * the identity is already on disk: every MCP server the hive mounts is declared
 * in an agent's own `mcp.json`, which this app writes. A process is ours iff its
 * argv matches a declared (command, args) line TOKEN FOR TOKEN from the start,
 * AND it is detached (`pgid === pid` — it escaped the session group that would
 * otherwise have swept it), AND nobody owns it (`ppid === 1`) or the session
 * being torn down right now is its parent.
 *
 * Every clause is load-bearing; each one alone is a false positive waiting to
 * happen:
 *   - identity alone would kill a LIVE session's server, which has an owner;
 *   - detachment-alone would kill unrelated detached daemons — `codegraph
 *     serve --mcp` on a non-hive project, `openclaw … gateway` — which are
 *     exactly the processes this floor must NOT touch.
 *
 * Deliberately NOT matched: a server whose declared command is a wrapper (`npx`,
 * `uvx`) resolves to a different argv[0] in the process table, so it does not
 * match and is left alone. That is fail-OPEN and intentional: a missed leak is
 * recoverable, a killed bystander on someone else's machine is not. None of the
 * 85 measured orphans was a wrapper — they are direct `bun`/`node` invocations.
 *
 * The decision is pure (`reapTargets`) and the kill lives in `reapHiveMcp`, the
 * same split as palaceReap.ts, so the rule is unit-testable with a synthetic
 * process table and no `ps`, and no real process is ever at risk in a test.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hardKillTree } from './procKill';

/** One MCP server command line as the app declared it in an agent's `mcp.json`. */
export interface DeclaredServer {
  name: string;
  command: string;
  args: string[];
}

/** One row of the process table, as far as these rules care. */
export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** The `command` column: argv, space-joined (see argvTokens). */
  command: string;
}

/**
 * The MCP server command lines the hive has declared, read from every agent's
 * own `mcp.json`.
 *
 * `mcp.json` and not the catalog: the file is what the app actually mounted, so
 * it cannot drift from the running configuration, and it is machine-written
 * JSON rather than a config format we would have to parse. It keeps declaring
 * servers for agents that have since been archived, which is exactly what a
 * historical leak needs.
 *
 * The codex `.codex/config.toml` is NOT read. Codex mounts the same catalog
 * (`codexMcpServers()` filters the same map that produces `mcp.json`, minus the
 * two servers withheld on that provider), so `mcp.json` is a superset of it, and
 * parsing a second format would add a parser for no additional coverage. The
 * bound this leaves is a floor with only codex agents and no Claude agent at
 * all; there, nothing is declared and nothing is reaped. Stated, not hidden.
 */
export function declaredServerLines(root: string): DeclaredServer[] {
  const agentsDir = join(root, 'agents');
  if (!existsSync(agentsDir)) return [];
  const out: DeclaredServer[] = [];
  const seen = new Set<string>();
  let entries: string[];
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  for (const name of entries) {
    const file = join(agentsDir, name, 'mcp.json');
    if (!existsSync(file)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue; // a half-written or hand-edited file declares nothing
    }
    const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
    if (!servers || typeof servers !== 'object') continue;
    for (const [serverName, value] of Object.entries(servers as Record<string, unknown>)) {
      const v = value as { command?: unknown; args?: unknown } | null;
      if (!v || typeof v.command !== 'string' || v.command === '') continue;
      const args = Array.isArray(v.args) ? v.args.map((a) => String(a)) : [];
      // Two agents declaring the same server is the norm (13 mcp.json files,
      // one catalog), so collapse before matching rather than comparing 13x.
      const key = [v.command, ...args].join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: serverName, command: v.command, args });
    }
  }
  return out;
}

/**
 * Parse `ps -axo pid=,ppid=,pgid=,command=`. Rows whose numbers do not parse, or
 * that carry no command, are dropped: an unreadable row must never become a
 * kill target, and dropping it can only ever FAIL open.
 */
export function parsePsRows(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!m) continue;
    const command = m[4];
    if (!command) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command });
  }
  return rows;
}

/**
 * Split a `ps` command column into argv tokens.
 *
 * Whitespace-splitting is lossy when an argument itself contains a space, and
 * this is the one place where that matters: a wrong split can only produce a
 * token sequence that no longer matches a declared line, i.e. it fails OPEN.
 * The declared lines this floor generates are space-free (absolute paths under
 * `HarnessAgents/worktrees/…`), so the lossy case does not arise in practice.
 */
export function argvTokens(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

/**
 * Does this argv match a declared server line from its start?
 *
 * Token EQUALITY, never substring: a `grep -F /path/to/trello-mcp/build/index.js`
 * or a `tail -f` on a server log has our path in its argv and must not match, and
 * neither must `/path/to/server.js.bak`. The command token anchors it.
 */
export function matchesDeclared(argv: string[], declared: DeclaredServer[]): boolean {
  if (argv.length === 0) return false;
  for (const d of declared) {
    if (argv[0] !== d.command) continue;
    if (argv.length < d.args.length + 1) continue;
    let ok = true;
    for (let i = 0; i < d.args.length; i++) {
      if (argv[i + 1] !== d.args[i]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

export interface ReapDecisionOptions {
  /** pid of a session being torn down right now: its detached MCP children are
   *  ours to collect even though they are still parented to it. */
  sessionPid?: number;
  /** Never a candidate. */
  selfPid: number;
}

/**
 * The pids to reap, given a process table and the declared server lines.
 *
 * A candidate is a declared server that is DETACHED (`pgid === pid`) and either
 * orphaned (`ppid === 1`) or a child of the session being torn down. Everything
 * else is left strictly alone — a live session's attached server, daemons on
 * projects that are not ours, an unrelated process that merely mentions our paths.
 */
export function reapTargets(
  rows: ProcRow[],
  declared: DeclaredServer[],
  opts: ReapDecisionOptions
): number[] {
  if (declared.length === 0) return [];
  const pids: number[] = [];
  for (const row of rows) {
    if (!Number.isInteger(row.pid) || row.pid <= 1) continue;
    if (row.pid === opts.selfPid) continue;
    if (opts.sessionPid !== undefined && row.pid === opts.sessionPid) continue;
    // Detached: it left the session's process group, which is why the group
    // sweep cannot see it. An ATTACHED server is already covered by that sweep.
    if (row.pgid !== row.pid) continue;
    const owned = row.ppid === 1
      || (opts.sessionPid !== undefined && row.ppid === opts.sessionPid);
    if (!owned) continue;
    if (!matchesDeclared(argvTokens(row.command), declared)) continue;
    pids.push(row.pid);
  }
  return pids;
}

export interface ReapResult {
  /** pids that were SIGKILLed as a group. */
  reaped: number[];
  /** True when the process table could not be read — "cannot verify", never
   *  "nothing to do". */
  unreadable: boolean;
}

/**
 * Read the process table, decide, and kill. Best-effort by design: it runs on
 * the archive/respawn/quit paths and at app start, so it must never throw into
 * its caller, and an unreadable table must degrade to doing nothing rather than
 * to guessing.
 *
 * Each target is killed with `hardKillTree`, i.e. as a process GROUP: the server
 * is its own group leader, so this also collects whatever IT spawned.
 *
 * No recycled-pgid guard, unlike procKill's delayed sweep: that one waits
 * KILL_GRACE_MS (4s), so the pid it is about to `kill(-pid)` can already have
 * been recycled as an unrelated group — the hazard shouldSweep exists for. Here
 * the table is read and the pids killed in one synchronous loop, milliseconds
 * apart, and every target was alive in that very snapshot. Re-checking would add
 * a second `ps` per reap for a window no scheduler can exploit.
 */
export function reapHiveMcp(root: string, opts: { sessionPid?: number } = {}): ReapResult {
  const declared = declaredServerLines(root);
  if (declared.length === 0) return { reaped: [], unreadable: false };
  let stdout: string;
  try {
    const r = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,command='], {
      timeout: 3_000,
      encoding: 'utf8'
    });
    if (r.error || r.status !== 0 || typeof r.stdout !== 'string') {
      return { reaped: [], unreadable: true };
    }
    stdout = r.stdout;
  } catch {
    return { reaped: [], unreadable: true };
  }
  const pids = reapTargets(parsePsRows(stdout), declared, {
    sessionPid: opts.sessionPid,
    selfPid: process.pid
  });
  const reaped: number[] = [];
  for (const pid of pids) {
    try { hardKillTree(pid); reaped.push(pid); } catch { /* already gone */ }
  }
  return { reaped, unreadable: false };
}

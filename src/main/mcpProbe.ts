/**
 * t-069 — a mounted MCP server that dies before it can serve is invisible.
 *
 * `buildDefaultMcpServers` decides whether a server is mounted from what is
 * DECLARED: the catalog entry, the consent map, the project binding. That is
 * enough for a server whose command line is self-contained, and it is exactly
 * NOT enough for one that reads an external config file. The failure mode there
 * is the worst one available: the server lands in the agent's `mcp.json` (or its
 * codex `config.toml`) looking exactly like a healthy one, the client starts it,
 * it exits on its own validation error, and the client shows a server that never
 * connects. The agent is missing tools and nothing anywhere says why.
 *
 * Diagnosed for real on 2026-09-22: `~/.config/magenio/burd.json` carried one key
 * the magento-mcp schema rejects (`ssh.password`), so the Magento server died at
 * startup and EVERY project agent silently lost its Magento tools. Four rounds of
 * hunting went into a one-line config typo, because the only signal was "the tool
 * is not there".
 *
 * This module answers the one question a declaration cannot: DOES IT COME UP? It
 * runs the exact command line the client will run and reads the outcome. It
 * deliberately does NOT re-implement the server's schema — a copied validator is
 * how two validators drift apart, and the server's own message ("ssh:
 * Unrecognized key: \"password\"") is more precise than any copy. The probe adds
 * no knowledge; it only makes the server's own verdict audible.
 *
 * Contract, and its one sharp edge: a stdio MCP server whose config it accepts
 * reaches `server.connect()` and then exits 0 when stdin closes (the probe writes
 * nothing and closes the pipe, so the transport ends immediately). A server that
 * refuses its config exits NON-ZERO BEFORE serving, printing the reason on stderr.
 * So `status === 0`, or a process still running when our timeout cuts it off, is
 * "it came up"; a non-zero exit is "it refused to start".
 *
 * The sharp edge, stated plainly: for a server that exits non-zero on stdin EOF
 * for some reason OTHER than a bad config, the probe would report a false
 * negative. That is why it is only applied where a non-zero exit is unambiguous
 * (magento, whose startup banner is printed after `loadConfig` succeeds), and why
 * the consequence of a refusal is a loud log line + a floor-level warning rather
 * than a silent omission.
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';

export type McpServerSpec = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type McpProbeResult =
  | { ok: true; alive: boolean }
  | { ok: false; reason: 'spawn-failed' | 'exit'; detail: string };

export type ProbeOptions = {
  timeoutMs?: number;
  /** Bypass the fingerprint cache — for a caller that must not see a stale verdict. */
  noCache?: boolean;
};

export const DEFAULT_PROBE_TIMEOUT_MS = 2000;

const MAX_DETAIL_CHARS = 400;
const MAX_DETAIL_LINES = 2;
const CACHE_LIMIT = 256;

/**
 * Mask the VALUE of anything that names a secret, and nothing else.
 *
 * A validation error is useful precisely because it names the offending FIELD,
 * so this must never touch `ssh: Unrecognized key: "password"` — where the
 * secret word is the message, not a value. Two shapes are masked:
 *   - JSON/JS style, quoted key: `"db.password": "hunter2"` → `"db.password":<redacted>`
 *   - assignment style (TOML/ini/shell): `password = 'hunter2'` → `password=<redacted>`
 * A bare `key: ` form is deliberately NOT masked: it is how the messages we want
 * to keep are shaped ("Unrecognized key: ...", "password: must be a string with
 * at least 1 character(s)").
 */
export function redactSecretValues(text: string): string {
  const SECRET_WORD = 'pass(?:word|wd)?|secret|token|api[_-]?key|private[_-]?key|key|credential';
  return text
    .replace(
      new RegExp(`("[^"]*(?:${SECRET_WORD})[^"]*"\\s*:\\s*)("[^"]*"|[^,}\\s]+)`, 'gi'),
      '$1<redacted>'
    )
    .replace(
      new RegExp(`\\b([A-Za-z0-9_.-]*(?:${SECRET_WORD})[A-Za-z0-9_.-]*)(\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s,}#]+)`, 'gi'),
      '$1=<redacted>'
    );
}

/** The first couple of non-empty lines, capped. A startup error is one or two
 *  lines; a stack trace behind it adds nothing a log reader needs. */
export function condenseDetail(stderr: string | undefined): string {
  const lines = String(stderr ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, MAX_DETAIL_LINES);
  const joined = lines.join(' | ');
  return joined.length > MAX_DETAIL_CHARS ? `${joined.slice(0, MAX_DETAIL_CHARS)}…` : joined;
}

/**
 * Cache key = the command line + the fingerprint of every arg that is a FILE.
 * Both the server bundle and the config file it is pointed at matter: editing
 * `burd.json` must invalidate a previous verdict, and so must replacing the
 * bundle. Anything else the child does (network, a missing credential on the
 * far side) is outside what a startup probe observes anyway.
 */
function probeCacheKey(spec: McpServerSpec): string {
  const parts = [spec.command, ...spec.args, JSON.stringify(spec.env ?? {})];
  for (const arg of spec.args) {
    if (!arg || arg.startsWith('-')) continue;
    try {
      const st = statSync(arg);
      parts.push(`${arg}:${st.mtimeMs}:${st.size}`);
    } catch {
      /* not a path we can fingerprint — the arg itself is already in the key */
    }
  }
  return parts.join('\u0000');
}

const probeCache = new Map<string, McpProbeResult>();

/** Test seam: drop every cached verdict. */
export function clearProbeCache(): void {
  probeCache.clear();
}

/**
 * Run the server's own command line and report whether it came up.
 *
 * Blocking (`spawnSync`) on purpose: the callers are synchronous spawn-time paths
 * that cannot await, and the whole probe is bounded by `timeoutMs`. It is cached
 * per command line + file fingerprints, so the ~200-400ms is paid once per
 * distinct config, not once per spawn — the same map is built two or three times
 * for a single spawn (settings, `--mcp-config`, codex tables).
 */
export function probeStdioServer(spec: McpServerSpec, opts: ProbeOptions = {}): McpProbeResult {
  const key = probeCacheKey(spec);
  const hit = opts.noCache ? undefined : probeCache.get(key);
  if (hit) return hit;

  const result = runProbe(spec, opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  if (probeCache.size >= CACHE_LIMIT) probeCache.clear();
  probeCache.set(key, result);
  return result;
}

function runProbe(spec: McpServerSpec, timeoutMs: number): McpProbeResult {
  try {
    // stdin: an empty pipe (written then closed) — the client holds it open,
    // but nothing about STARTUP depends on that, and closing it is what bounds
    // the probe: a server that came up ends its transport and exits.
    const r = spawnSync(spec.command, spec.args, {
      input: '',
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1 << 20,
      windowsHide: true,
      env: { ...process.env, ...(spec.env ?? {}) }
    });
    const err = r.error as NodeJS.ErrnoException | undefined;
    // A timed-out process was still running. A process that died from another
    // signal did not come up, even though spawnSync reports both via r.signal.
    if (err?.code === 'ETIMEDOUT') return { ok: true, alive: true };
    if (err) return { ok: false, reason: 'spawn-failed', detail: condenseDetail(err.message) };
    if (r.status === 0) return { ok: true, alive: false };
    const detail = condenseDetail(r.stderr) || (r.signal
      ? `terminated by signal ${r.signal}`
      : `exited with code ${r.status} and no message on stderr`);
    return { ok: false, reason: 'exit', detail: redactSecretValues(detail) };
  } catch (e) {
    return { ok: false, reason: 'spawn-failed', detail: condenseDetail(String(e)) };
  }
}

/**
 * MCP server preflight + provisioning (main process).
 *
 * ELECTRON-FREE by design, and every side effect is injected: hive.ts imports
 * this to decide whether to declare a server at spawn time, and node:test
 * exercises it with fakes. `nodePresenceDeps()`/`nodeInstallDeps()` are the
 * production wirings.
 *
 * Why it exists: a declared-but-broken MCP server is the worst failure shape.
 * The client keeps retrying, the agent silently has no tools, and the intake
 * mission reports "no cards" when the truth is "Trello was never reachable".
 *
 * SECURITY: the credentials check opens the server's own .env. It keeps
 * BOOLEANS ONLY — no value is ever returned, logged, or put in an error.
 *
 * Contract: docs/superpowers/specs/2026-09-05-trello-intake-design.md §C.
 */
import { existsSync, accessSync, constants, readFileSync, readdirSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { TRELLO_MCP_REPO_URL, TRELLO_MCP_TAG } from '../shared/mcpCatalog';

export type McpPresenceReason =
  | 'not_configured'       // command/args not filled in from Settings
  | 'command_missing'      // the binary does not exist or is not executable
  | 'entry_missing'        // the entry file (the build output) does not exist
  | 'credentials_missing'; // the package's .env lacks a required key

export interface McpPresence {
  ok: boolean;
  reason?: McpPresenceReason;
  /** Human-readable detail. NAMES a missing key; never carries its value. */
  detail?: string;
}

export interface McpConsent {
  enabled: boolean;
  agents?: string[];
  command?: string;
  args?: string[];
}

export interface PresenceDeps {
  fileExists: (p: string) => boolean;
  isExecutable: (p: string) => boolean;
  /** File contents, or null when unreadable/absent. */
  readText: (p: string) => string | null;
}

/** Keys the Trello server refuses to start without (its src/index.ts throws). */
const TRELLO_REQUIRED_ENV = ['TRELLO_API_KEY', 'TRELLO_TOKEN'] as const;

/** True iff `text` assigns a NON-EMPTY value to `key`. Returns a boolean and
 *  nothing else: the value is never returned, logged, or retained. */
export function envAssignsNonEmpty(text: string, key: string): boolean {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const name = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (name !== key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > 0) return true;
  }
  return false;
}

/**
 * Can this user-configured MCP server actually run right now?
 *
 * Checks, in order: command + args filled in → binary present and executable →
 * entry file present → (trello only) the package .env carries the required keys.
 */
export function checkMcpPresence(
  entryId: string,
  consent: McpConsent | undefined,
  deps: PresenceDeps
): McpPresence {
  const command = consent?.command?.trim();
  const entry = consent?.args?.[0]?.trim();
  if (!command || !entry) {
    return { ok: false, reason: 'not_configured', detail: 'Set the launch command and arguments in Settings.' };
  }
  if (!deps.fileExists(command) || !deps.isExecutable(command)) {
    return { ok: false, reason: 'command_missing', detail: `Not an executable file: ${command}` };
  }
  if (!deps.fileExists(entry)) {
    return { ok: false, reason: 'entry_missing', detail: `Entry file not found: ${entry}. The server may need to be built.` };
  }
  if (entryId === 'trello') {
    // The server loads `join(__dirname, '../.env')` — mirror that exactly, so
    // we look where it actually looks.
    const envPath = join(dirname(entry), '..', '.env');
    const text = deps.fileExists(envPath) ? deps.readText(envPath) : null;
    if (text === null) {
      return { ok: false, reason: 'credentials_missing', detail: `No .env at ${envPath}. It must set ${TRELLO_REQUIRED_ENV.join(' and ')}.` };
    }
    const missing = TRELLO_REQUIRED_ENV.filter((key) => !envAssignsNonEmpty(text, key));
    if (missing.length) {
      return { ok: false, reason: 'credentials_missing', detail: `${envPath} is missing a value for ${missing.join(' and ')}.` };
    }
  }
  return { ok: true };
}

/** Production wiring of the preflight checks. */
export function nodePresenceDeps(): PresenceDeps {
  return {
    fileExists: (p) => {
      try { return existsSync(p); } catch { return false; }
    },
    isExecutable: (p) => {
      try { accessSync(p, constants.X_OK); return true; } catch { return false; }
    },
    readText: (p) => {
      try { return readFileSync(p, 'utf8'); } catch { return null; }
    }
  };
}

export interface InstallDeps {
  dirExistsNonEmpty: (p: string) => boolean;
  /** Absolute path of a binary on PATH, or null. */
  which: (bin: string) => string | null;
  run: (cmd: string, args: string[], cwd?: string) => { ok: boolean; stderr?: string };
  fileExists: (p: string) => boolean;
  copyFile: (from: string, to: string) => void;
}

/**
 * Clone + build the Trello MCP server into `destDir`.
 *
 * An EXPLICIT user action only — never called at spawn, never automatic. The
 * app is cloning third-party code that will then run inside its own agents, so
 * the clone is pinned to a tag and the toolchain is checked before anything is
 * fetched.
 *
 * Credentials are NOT written: the .env lands with empty values and the user
 * fills it in. The preflight then reports `credentials_missing` until they do,
 * which is the true state.
 */
export async function installTrelloMcp(
  destDir: string,
  deps: InstallDeps
): Promise<{ ok: true; command: string; args: string[] } | { ok: false; error: string }> {
  if (deps.dirExistsNonEmpty(destDir)) {
    return { ok: false, error: `${destDir} exists and is not empty. Remove it or choose another directory — the installer never overwrites.` };
  }
  // The server's own build script is `bun build src/index.ts …`, so bun is not
  // optional. Fail here rather than half-way through, leaving a broken directory.
  const bun = deps.which('bun');
  if (!bun) {
    return { ok: false, error: 'bun was not found on PATH. The Trello MCP server builds with bun — install it (https://bun.sh) and try again.' };
  }

  const clone = deps.run('git', [
    'clone', '--depth', '1', '--branch', TRELLO_MCP_TAG, TRELLO_MCP_REPO_URL, destDir
  ]);
  if (!clone.ok) return { ok: false, error: `git clone failed: ${clone.stderr ?? 'unknown error'}` };

  const install = deps.run(bun, ['install'], destDir);
  if (!install.ok) return { ok: false, error: `bun install failed: ${install.stderr ?? 'unknown error'}` };

  const build = deps.run(bun, ['run', 'build'], destDir);
  if (!build.ok) return { ok: false, error: `bun run build failed: ${build.stderr ?? 'unknown error'}` };

  // Seed an EMPTY .env from whichever template the repo ships. Best-effort: a
  // missing template is not a failed install, it just means the user creates
  // the file themselves — the preflight tells them so either way.
  for (const template of ['.env.template', 'example.env']) {
    const from = join(destDir, template);
    if (deps.fileExists(from)) {
      deps.copyFile(from, join(destDir, '.env'));
      break;
    }
  }

  return { ok: true, command: bun, args: [join(destDir, 'build', 'index.js')] };
}

/** Production wiring of the installer. */
export function nodeInstallDeps(): InstallDeps {
  return {
    dirExistsNonEmpty: (p) => {
      try { return existsSync(p) && readdirSync(p).length > 0; } catch { return false; }
    },
    which: (bin) => {
      const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
      const out = (probe.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      return probe.status === 0 && out[0] ? out[0] : null;
    },
    run: (cmd, args, cwd) => {
      const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 300_000 });
      return { ok: r.status === 0, stderr: (r.stderr ?? '').trim() || undefined };
    },
    fileExists: (p) => {
      try { return existsSync(p); } catch { return false; }
    },
    copyFile: (from, to) => copyFileSync(from, to)
  };
}

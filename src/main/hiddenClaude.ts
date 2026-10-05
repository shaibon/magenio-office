import * as pty from 'node-pty';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveCommand, userShellPath } from './shellEnv';
import { expandTilde } from './fs';
import { projectDir } from './transcript';
import { ensureKilled } from './procKill';

/**
 * Shared helper: run a HIDDEN interactive claude session (ephemeral PTY) and
 * return the assistant's final text response.
 *
 * "Hidden" means: not added to the PtyManager, not emitted to the renderer,
 * not visible in the agent list or OfficeFloor scene. Each call spawns its own
 * session and kills it after capture — no /clear needed, no context bleed.
 *
 * Uses an interactive PTY (not `claude -p`) so calls draw from the user's
 * normal interactive plan quota, not the Agent SDK credit that moves to a
 * separate claim-required pool from 2026-06-15.
 *
 * Session lifecycle:
 *   spawn → boot-quiet detect → bracketed-paste prompt + \r → idle-settle →
 *   transcript JSONL extract (last assistant text block) → kill
 *
 * The session runs in a throwaway cwd (see `privateCwd`): the Claude Code project
 * dir is derived from the working directory, so a private one guarantees the call
 * owns its transcript even when the caller's directory also hosts a long-lived
 * session. That directory must sit under one the CLI already trusts — see
 * `createPrivateCwd`; a session in an untrusted one never writes a transcript at
 * all. The transcript is additionally identified by name — the set sampled before
 * the spawn — because a shared directory could grow a newer file mid-call.
 */

/** ms of PTY silence that signals the TUI is ready for input (boot complete). */
const BOOT_QUIET_MS = 1500;

/** Name prefix of a hidden call's throwaway cwd. Dot-prefixed so it stays out of
 *  the way in a listing of the directory that hosts it. */
export const PRIVATE_CWD_PREFIX = '.munder-hidden-';

export interface HiddenClaudeOptions {
  /** Model to use (e.g. 'claude-haiku-4-5'). */
  model: string;
  /** Working directory for the claude session. */
  cwd: string;
  /** Base claude command/binary. Defaults to 'claude'. */
  command?: string;
  /** Tools the session is forbidden to use. Defaults to ['Edit','Write','NotebookEdit']. */
  disallowedTools?: string[];
  /** Directories added via --add-dir (for context gathering). */
  addDirs?: string[];
  /** Hard cap ms before forcing prompt send regardless of boot activity. Default 7000. */
  bootCapMs?: number;
  /** ms of PTY silence after the prompt that signals response is complete. Default 3500. */
  idleMs?: number;
  /** Total timeout ms. Default 180000. */
  timeoutMs?: number;
  /** Extra env merged over the resolved shell env (e.g. the shared MemPalace). */
  env?: Record<string, string>;
  /**
   * Run the session in a throwaway directory instead of `cwd`. Default true: the
   * call is a self-contained text transform, so it must not see the caller's
   * project — and a private directory also makes its transcript unambiguous.
   * Set false only when the response genuinely depends on `cwd` for context.
   */
  privateCwd?: boolean;
}

export interface HiddenClaudeResult {
  ok: boolean;
  /** The assistant's final text response (stripped of any TUI framing). */
  text?: string;
  error?: string;
}

/** Every `.jsonl` transcript filename already present for `cwd`. Sampled BEFORE a
 *  spawn so the capture step can tell this session's own transcript from a file
 *  that merely happened to be written while the call was running — a long-lived
 *  session in the same working directory keeps rewriting its own. */
export function listTranscriptFiles(cwd: string): Set<string> {
  const seen = new Set<string>();
  try {
    const dir = projectDir(cwd);
    if (!existsSync(dir)) return seen;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      try { if (statSync(path.join(dir, f)).isFile()) seen.add(f); }
      catch { /* vanished between readdir and stat — not this session's */ }
    }
  } catch { /* unreadable directory reads as "nothing there yet" */ }
  return seen;
}

/**
 * Extract the last assistant text block from the newest transcript JSONL written
 * at or after `spawnedAt`. Reuses projectDir() from transcript.ts.
 *
 * `exclude` (from listTranscriptFiles(), taken before the spawn) is the filter
 * that identifies the session: only files this call created are eligible, so the
 * newest-by-mtime fallback can never return another session's text.
 */
export function extractLastAssistantText(
  cwd: string, spawnedAt: number, exclude?: ReadonlySet<string>
): string | null {
  try {
    const dir = projectDir(cwd);
    if (!existsSync(dir)) return null;

    const candidates: { f: string; mtime: number }[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      if (exclude?.has(f)) continue;
      try {
        const st = statSync(path.join(dir, f));
        if (!st.isFile()) continue;
        // 5 s slack covers a file that appears just before spawnedAt; `exclude`
        // is what actually rules out a pre-existing session. Sort by mtime and
        // take the newest of what is left.
        if (st.mtimeMs >= spawnedAt - 5000) candidates.push({ f, mtime: st.mtimeMs });
      } catch { /* file removed between readdir and stat — skip */ }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.mtime - a.mtime);

    const lines = readFileSync(path.join(dir, candidates[0].f), 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      let rec: { type?: unknown; message?: { content?: unknown[] } };
      try { rec = JSON.parse(trimmed); } catch { continue; }
      if (rec.type !== 'assistant') continue;
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      for (let j = content.length - 1; j >= 0; j--) {
        const block = content[j] as { type?: unknown; text?: unknown };
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          return block.text.trim();
        }
      }
    }
    return null;
  } catch { return null; }
}

/** The real path of `dir`, or `dir` itself when it cannot be resolved (deleted
 *  mid-call, permissions). Claude Code keys a transcript on the REAL path of its
 *  cwd, so every project dir we compute must use the same spelling. */
export function canonicalDir(dir: string): string {
  try { return realpathSync(dir); } catch { return dir; }
}

/** A throwaway directory for one hidden call, created inside `cwd`.
 *
 *  Deliberately NOT `os.tmpdir()`. Claude Code runs unattended only in a working
 *  directory it trusts, and trust is inherited from an ancestor listed in its own
 *  config (~/.claude.json → projects[<path>].hasTrustDialogAccepted). `/tmp` and
 *  `/var/folders` are not trusted and cannot be, so a call there stops at the
 *  "Is this a project you created or one you trust?" dialog — whose default is
 *  "No, exit" — and the session dies without ever writing a transcript, which the
 *  caller sees as "no assistant response found in transcript".
 *
 *  `cwd` is trusted by construction: the caller's own long-lived session already
 *  runs in it, which is only possible because it is trusted (or because nothing
 *  there prompts).
 *
 *  Returns null when the directory cannot be created — callers then run in `cwd`
 *  itself, which the pre-spawn snapshot still disambiguates. */
export function createPrivateCwd(cwd: string): string | null {
  try {
    return canonicalDir(mkdtempSync(path.join(cwd, PRIVATE_CWD_PREFIX)));
  } catch { return null; }
}

/** Drop a throwaway cwd and the transcript project dir the session left under it.
 *  Best-effort: a failed cleanup must never affect the caller's result. */
function disposePrivateCwd(dir: string | null): void {
  if (!dir) return;
  try { rmSync(projectDir(dir), { recursive: true, force: true }); } catch { /* best-effort */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

export function runHiddenClaude(prompt: string, opts: HiddenClaudeOptions): Promise<HiddenClaudeResult> {
  return new Promise((resolve) => {
    if (!prompt.trim()) { resolve({ ok: false, error: 'empty prompt' }); return; }
    // Defense-in-depth: `~` is shell syntax, not a path Node understands.
    const given = opts.cwd ? expandTilde(opts.cwd) : opts.cwd;
    if (!given || !existsSync(given)) {
      resolve({ ok: false, error: `cwd does not exist: ${opts.cwd}` });
      return;
    }
    // Resolve symlinks: Claude Code keys its transcript on the real path of its cwd,
    // so an unresolved spelling would send every lookup to the wrong project dir.
    const cwd = canonicalDir(given);
    opts = { ...opts, cwd };

    // A throwaway cwd keeps the session away from the caller's project AND gives
    // it a project dir of its own, so its transcript cannot be confused with a
    // session already living in `cwd`. Falls back to `cwd` if the temp dir cannot
    // be made — the pre-spawn snapshot below still identifies the right file.
    let privateDir: string | null = null;
    let sessionCwd = cwd;
    if (opts.privateCwd !== false) {
      privateDir = createPrivateCwd(cwd);
      if (privateDir) sessionCwd = privateDir;
    }
    const seenTranscripts = listTranscriptFiles(sessionCwd);

    const binary = (opts.command || 'claude').trim().split(/\s+/)[0] || 'claude';
    const exe = resolveCommand(binary);
    const disallowed = opts.disallowedTools ?? ['Edit', 'Write', 'NotebookEdit'];
    const addDirs = (opts.addDirs ?? []).filter((d) => d && existsSync(d));

    const args: string[] = [
      '--model', opts.model,
      '--permission-mode', 'bypassPermissions',
      '--disallowedTools', ...disallowed,
    ];
    for (const d of addDirs) { args.push('--add-dir', d); }

    const bootCapMs = opts.bootCapMs ?? 7000;
    const idleMs = opts.idleMs ?? 3500;
    const timeoutMs = opts.timeoutMs ?? 180_000;

    const spawnedAt = Date.now();
    // Windows: node-pty's CreateProcess can't exec the npm `.cmd`/extensionless
    // `claude` shim directly (ERROR_BAD_EXE_FORMAT, error 193) — route non-.exe
    // targets through cmd.exe. A real claude.exe (WinGet) launches directly. (#22)
    const winWrap = process.platform === 'win32' && !/\.(exe|com)$/i.test(exe);
    const spawnFile = winWrap ? (process.env.ComSpec || 'cmd.exe') : exe;
    const spawnArgs = winWrap ? ['/c', exe, ...args] : args;
    let ptyProc: pty.IPty;
    try {
      ptyProc = pty.spawn(spawnFile, spawnArgs, {
        name: 'xterm-color',
        cols: 220,
        rows: 50,
        cwd: sessionCwd,
        env: {
          ...process.env,
          PATH: userShellPath(),
          ...(opts.env ?? {}),
        } as Record<string, string>,
      });
    } catch (e) {
      disposePrivateCwd(privateDir);
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }

    let settled = false;
    let promptSent = false;
    let bootTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let bootMaxTimer: NodeJS.Timeout;
    let globalTimer: NodeJS.Timeout;

    // Hidden sessions are ephemeral CHECKS — nothing they spawn (MCP servers,
    // helpers) may outlive them. Kill politely, then sweep the process group so
    // every check releases its PIDs even if `claude` shrugs off the SIGHUP.
    const kill = () => {
      const pid = ptyProc.pid;
      try { ptyProc.kill(); } catch { /* noop */ }
      ensureKilled(pid);
    };

    const finish = (r: HiddenClaudeResult) => {
      if (settled) return;
      settled = true;
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      clearTimeout(bootMaxTimer);
      clearTimeout(globalTimer);
      kill();
      disposePrivateCwd(privateDir);
      resolve(r);
    };

    const captureAndFinish = () => {
      const text = extractLastAssistantText(sessionCwd, spawnedAt, seenTranscripts);
      finish(text
        ? { ok: true, text }
        : { ok: false, error: 'no assistant response found in transcript' });
    };

    const sendPrompt = () => {
      if (settled || promptSent) return;
      promptSent = true;
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
      // Bracketed paste + enter — same mechanism as submitToPty in useHive.ts.
      ptyProc.write(`\x1b[200~${prompt}\x1b[201~`);
      setTimeout(() => { if (!settled) ptyProc.write('\r'); }, 140);
    };

    bootMaxTimer = setTimeout(sendPrompt, bootCapMs);
    globalTimer = setTimeout(
      () => finish({ ok: false, error: 'hidden session timed out' }),
      timeoutMs,
    );

    ptyProc.onData(() => {
      if (!promptSent) {
        // Boot phase: reset quiet timer; send prompt once output goes quiet.
        if (bootTimer) clearTimeout(bootTimer);
        bootTimer = setTimeout(sendPrompt, BOOT_QUIET_MS);
      } else {
        // Response phase: reset idle timer; capture when output settles.
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(captureAndFinish, idleMs);
      }
    });

    // Session exited cleanly before idle — try to capture the transcript anyway.
    ptyProc.onExit(() => { if (!settled) captureAndFinish(); });
  });
}

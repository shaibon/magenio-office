/**
 * SCRIPT AUTOMATIONS — a scheduled `script` mission runs a program in the main
 * process, with no agent and no LLM tokens, and talks to a recipient only when the
 * program says something is wrong.
 *
 * Exit convention: 0 = nothing to report (no message); 10 = something found, stdout
 * (truncated) is the message body; any other exit, a timeout, or a failure to start
 * = an ERROR message to the recipient, so a broken check never looks like "all ok".
 *
 * SECURITY. The script runs OUTSIDE every agent sandbox, so no agent may get to pick
 * what runs:
 *  - Only the human approves a script (native file dialog in Settings); the approval
 *    stores the file's sha256 in the app config, which agents cannot write, and the
 *    broker's `/automations` cannot create, change or delete a `script` mission.
 *  - The path is NOT trusted (the hive's bin/ is agent-writable). At each run the file
 *    is read ONCE, hashed, and refused on a mismatch; what executes is a private copy of
 *    exactly those bytes in a 0700 directory agents cannot reach, so swapping the file
 *    between the check and the exec (TOCTOU) gains nothing.
 *  - Minimal environment (no inherited secrets) plus a dedicated READ-ONLY broker token.
 * Electron-free on purpose: the host injects storage, broker and delivery.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, constants as FS, fstatSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** `sig` = HMAC of the other fields under a key only the app can read (see approvalSignature). */
export interface ApprovedScript { id: string; path: string; sha256: string; approvedAt: number; sig?: string }

export const SCRIPT_EXIT_FOUND = 10;
export const SCRIPT_DEFAULT_TIMEOUT_MS = 60_000;
export const SCRIPT_MAX_TIMEOUT_MS = 10 * 60_000;
export const SCRIPT_MAX_FILE_BYTES = 1024 * 1024;
export const SCRIPT_MAX_MESSAGE = 4000;
const MAX_CAPTURE = 64 * 1024;
const MAX_STDERR = 2 * 1024;

export const sha256Hex = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** Signature of an approval record. The config file is writable by any process of the same macOS
 *  user, so the record is only trusted if it verifies under a key kept in the Keychain (safeStorage). */
export function approvalSignature(key: string, e: Pick<ApprovedScript, 'id' | 'path' | 'sha256' | 'approvedAt'>): string {
  return createHmac('sha256', key).update(['script-approval-v1', e.id, e.path, e.sha256, String(e.approvedAt)].join('\0')).digest('hex');
}
export function verifyApproval(key: string | null, e: ApprovedScript): boolean {
  if (!key || typeof e.sig !== 'string' || !/^[0-9a-f]{64}$/.test(e.sig)) return false;
  return timingSafeEqual(Buffer.from(approvalSignature(key, e), 'hex'), Buffer.from(e.sig, 'hex'));
}

/** Read a regular file through ONE descriptor: non-blocking (a FIFO swapped in cannot hang the main
 *  thread), no-follow on the last component, fstat must say regular file, bounded read. Throws otherwise. */
export function readRegularFile(path: string, max = SCRIPT_MAX_FILE_BYTES): Buffer {
  const fd = openSync(path, FS.O_RDONLY | FS.O_NONBLOCK | FS.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'ENOTREG' });
    if (st.size > max) throw Object.assign(new Error('file too large'), { code: 'E2BIG' });
    const buf = Buffer.alloc(Math.min(st.size, max) + 1);
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
    }
    if (n > max) throw Object.assign(new Error('file too large'), { code: 'E2BIG' });
    return buf.subarray(0, n);
  } finally { closeSync(fd); }
}

/** A `script` mission as stored. It has NO recipient: every outcome goes to the one global alert agent. */
export interface ScriptMission {
  id: string; label: string; scriptId?: string; scriptTimeoutMs?: number;
  intervalMs?: number; weekly?: { days: number[]; minute: number };
  activeWindow?: { days: number[]; fromMinute: number; toMinute: number; outsideIntervalMs?: number; outsideMinutes?: number[] };
  enabled?: boolean;
  lastFiredAt?: number;
  sig?: string;
}

/** Stable JSON: keys sorted, undefined dropped, so the same record always serialises the same way and no value can
 *  bleed into a neighbour. */
const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
};
const hmacHex = (key: string, parts: string[]): string => createHmac('sha256', key).update(parts.join('\0')).digest('hex');
const sigOk = (key: string | null, sig: unknown, expected: (k: string) => string): boolean =>
  !!key && typeof sig === 'string' && /^[0-9a-f]{64}$/.test(sig) && timingSafeEqual(Buffer.from(expected(key), 'hex'), Buffer.from(sig, 'hex'));

/** HMAC over the WHOLE mission record except `label`, `lastFiredAt` and `sig` itself: script, calendar, timeout,
 *  `enabled`, and any field somebody adds. Only the Settings IPC signs it. Same Keychain key as the approvals. */
export function missionSignature(key: string, m: ScriptMission): string {
  const { label: _l, lastFiredAt: _f, sig: _s, ...rest } = m;
  return hmacHex(key, ['script-mission-v2', canon(rest)]);
}
export const verifyMissionSig = (key: string | null, m: ScriptMission): boolean => sigOk(key, m.sig, (k) => missionSignature(k, m));

/** The single recipient of every script outcome, chosen in Settings and signed like the rest. */
export interface ScriptAlertRecord { agent: string; sig: string }
export const alertSignature = (key: string, agent: string): string => hmacHex(key, ['script-alert-v1', agent]);
/** The configured alert agent if its signature verifies and it still exists, otherwise god. */
export function resolveAlertAgent(key: string | null, rec: ScriptAlertRecord | undefined, godId: string, exists: (id: string) => boolean): string {
  if (rec && typeof rec.agent === 'string' && sigOk(key, rec.sig, (k) => alertSignature(k, rec.agent)) && exists(rec.agent)) return rec.agent;
  return godId;
}

/** The shortest gap the signed calendar can legitimately leave between two starts. A start sooner than this after
 *  the previous one is refused (a weekly mission is held to one start a minute). */
export function minGapMs(m: ScriptMission): number {
  if (m.weekly) return 60_000;
  const iv = typeof m.intervalMs === 'number' && m.intervalMs > 0 ? m.intervalMs : 60_000;
  const out = m.activeWindow?.outsideIntervalMs;
  return Math.min(iv, typeof out === 'number' && out > 0 ? out : iv);
}

export interface ScriptOutcome {
  status: 'ok' | 'found' | 'error' | 'skipped';
  exitCode: number | null;
  reason?: string;
  delivered: boolean;
}

export interface ScriptRunnerDeps {
  approved(): ApprovedScript[];
  /** Is this approval record authentic (signed by the app)? An unverifiable record is refused. */
  verify(entry: ApprovedScript): boolean;
  /** Is this mission record exactly what a human signed in Settings? */
  verifyMission(m: ScriptMission): boolean;
  /** Recipient of every outcome (found and error): the signed global alert agent, or god. */
  alertAgent(): string;
  /** Where a REFUSED (unauthentic) mission is reported: always god. */
  fixedRecipient(): string;
  /** Private (0700) directory where the verified copy is executed from. */
  cacheDir: string;
  /** A read-only broker capability for this run, or null when the broker is down. */
  grant(missionId: string): { url: string; token: string } | null;
  revoke(missionId: string): void;
  /** Deliver a message. Returns false when it could not be delivered. */
  send(to: string, subject: string, body: string): boolean;
  log(event: Record<string, unknown>): void;
  spawn?: typeof nodeSpawn;
  now?: () => number;
}

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s);

export function createScriptRunner(deps: ScriptRunnerDeps) {
  const running = new Set<string>();
  /** Last start per mission, in memory: config.json's lastFiredAt is agent-writable, so it never decides whether a run is due. */
  const lastStart = new Map<string, number>();
  const spawnFn = deps.spawn ?? nodeSpawn;
  const now = deps.now ?? Date.now;

  async function run(m: ScriptMission): Promise<ScriptOutcome> {
    if (running.has(m.id)) {
      deps.log({ kind: 'script-automation', id: m.id, label: m.label, outcome: 'skipped', reason: 'previous run still in progress' });
      return { status: 'skipped', exitCode: null, reason: 'previous run still in progress', delivered: false };
    }
    running.add(m.id);
    const started = now();
    let copy: string | null = null;
    try {
      const fail = (reason: string, exitCode: number | null = null, stderr = ''): ScriptOutcome => {
        const body = `The scheduled script check "${m.label}" did NOT run to a result: ${reason}.${stderr ? `\n\nstderr:\n${trunc(stderr.trim(), 500)}` : ''}\n\nThis is an automated message (no agent ran). Treat the check as broken, not as "all ok".`;
        const delivered = deps.send(deps.alertAgent(), `${m.label}: script check FAILED`, body);
        return { status: 'error', exitCode, reason, delivered };
      };
      const finish = (o: ScriptOutcome, extra: Record<string, unknown> = {}): ScriptOutcome => {
        deps.log({ kind: 'script-automation', id: m.id, label: m.label, scriptId: m.scriptId, outcome: o.status, exitCode: o.exitCode, reason: o.reason, delivered: o.delivered, durationMs: now() - started, ...extra });
        return o;
      };

      // FIRST, before any token or file access: is this mission what a human authorised? If not, nothing is
      // granted or run, and the report goes to a recipient the record cannot choose.
      if (!deps.verifyMission(m)) {
        const reason = 'the mission is not authentic (missing or invalid signature: the record was not saved from Settings, or was edited since)';
        const to = deps.fixedRecipient();
        const delivered = deps.send(to, `${m.label}: script check REFUSED`, `A scheduled script mission "${m.label}" (${m.id}) was NOT run: ${reason}. It named script "${m.scriptId}". Re-save it in Settings > Schedules if it is yours; otherwise something edited the app config.`);
        return finish({ status: 'error', exitCode: null, reason, delivered });
      }
      const prev = lastStart.get(m.id);
      if (prev !== undefined && started - prev < minGapMs(m) - 1000) {
        deps.log({ kind: 'script-automation', id: m.id, label: m.label, outcome: 'skipped', reason: 'too soon after the previous start' });
        return { status: 'skipped', exitCode: null, reason: 'too soon after the previous start', delivered: false };
      }
      lastStart.set(m.id, started);
      const entry = deps.approved().find((s) => s.id === m.scriptId);
      if (!entry) return finish(fail('the script is not approved (approve it in Settings)'));
      if (!deps.verify(entry)) return finish(fail('the approval record is not authentic (missing or invalid signature); approve the script again in Settings'));
      let bytes: Buffer;
      try {
        bytes = readRegularFile(entry.path);
      } catch (e) { return finish(fail(`cannot read ${entry.path}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`)); }
      if (sha256Hex(bytes) !== entry.sha256) return finish(fail('the script changed since it was approved (hash mismatch); approve it again in Settings'));

      // Execute our own copy of the bytes we just verified, never the original path.
      mkdirSync(deps.cacheDir, { recursive: true, mode: 0o700 });
      try { chmodSync(deps.cacheDir, 0o700); } catch { /* best effort */ }
      copy = join(deps.cacheDir, `${entry.sha256.slice(0, 16)}-${randomBytes(6).toString('hex')}`);
      writeFileSync(copy, bytes, { mode: 0o700, flag: 'wx' });

      const cap = deps.grant(m.id);
      const env: Record<string, string> = {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin',
        HOME: process.env.HOME ?? '', LANG: process.env.LANG ?? 'en_US.UTF-8',
        MD_AUTOMATION_ID: m.id,
        ...(cap ? { MD_BROKER_URL: cap.url, MD_BROKER_TOKEN: cap.token } : {})
      };
      const timeoutMs = Math.min(Math.max(m.scriptTimeoutMs ?? SCRIPT_DEFAULT_TIMEOUT_MS, 1000), SCRIPT_MAX_TIMEOUT_MS);

      const res = await new Promise<{ code: number | null; signal: string | null; out: string; err: string; timedOut: boolean; spawnError?: string }>((resolve) => {
        let out = ''; let err = ''; let timedOut = false; let settled = false;
        let child: ChildProcess;
        const done = (r: { code: number | null; signal: string | null; spawnError?: string }): void => {
          if (settled) return; settled = true; clearTimeout(timer);
          resolve({ ...r, out, err, timedOut });
        };
        const timer = setTimeout(() => {
          timedOut = true;
          try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
          // Do NOT wait for 'close': a detached grandchild can keep the pipes open indefinitely.
          // Drop the pipes and settle now, so the run ends and its broker token is revoked at the timeout.
          try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* already closed */ }
          done({ code: null, signal: 'SIGKILL' });
        }, timeoutMs);
        try {
          child = spawnFn(copy!, [], { cwd: deps.cacheDir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        } catch (e) { done({ code: null, signal: null, spawnError: (e as Error).message }); return; }
        child.stdout?.on('data', (c: Buffer) => { if (out.length < MAX_CAPTURE) out += c.toString('utf8'); });
        child.stderr?.on('data', (c: Buffer) => { if (err.length < MAX_STDERR) err += c.toString('utf8'); });
        child.on('error', (e) => done({ code: null, signal: null, spawnError: e.message }));
        child.on('close', (code, signal) => done({ code, signal }));
      });

      if (res.spawnError) return finish(fail(`could not start (${res.spawnError})`, null, res.err));
      if (res.timedOut) return finish(fail(`timed out after ${Math.round(timeoutMs / 1000)}s and was killed`, null, res.err));
      if (res.code === 0) return finish({ status: 'ok', exitCode: 0, delivered: false });
      if (res.code === SCRIPT_EXIT_FOUND) {
        const text = trunc(res.out.trim(), SCRIPT_MAX_MESSAGE) || '(the script reported something but printed nothing)';
        const delivered = deps.send(deps.alertAgent(), m.label, text);
        return finish({ status: 'found', exitCode: SCRIPT_EXIT_FOUND, delivered });
      }
      return finish(fail(res.signal ? `killed by signal ${res.signal}` : `exited with code ${res.code}`, res.code, res.err));
    } catch (e) {
      // Never let a failure here read as "nothing to report".
      const reason = `internal error (${(e as Error).message})`;
      const delivered = deps.send(deps.alertAgent(), `${m.label}: script check FAILED`, `The scheduled script check "${m.label}" did NOT run to a result: ${reason}.`);
      deps.log({ kind: 'script-automation', id: m.id, label: m.label, outcome: 'error', reason, delivered });
      return { status: 'error', exitCode: null, reason, delivered };
    } finally {
      if (copy) { try { unlinkSync(copy); } catch { /* already gone */ } }
      deps.revoke(m.id);
      running.delete(m.id);
    }
  }

  return { run, isRunning: (id: string) => running.has(id) };
}

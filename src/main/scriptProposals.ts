/**
 * SCRIPT PROPOSALS: one-click approval. god PROPOSES a check script through the broker; the Boss reads it in
 * Settings > Schedules and presses Approve. Nothing an agent sends approves, signs or schedules anything:
 *  - `propose` only reads the file (readRegularFile), keeps a private copy plus its sha256, and stores a signed record.
 *  - `approve` runs in main, from the renderer's click only, on the data stored HERE (never what the renderer sends back):
 *    it re-checks the copy and the original file against the stored sha256, then returns the new approved-scripts and
 *    missions lists (script + mission signed, the replaced trigger switched off) for the caller to write in ONE config write.
 *    Any failure returns an error and applies nothing.
 * Electron-free; the host supplies the key, the directory, the roster and the current config.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { normalizeWeekly } from '../shared/weeklySchedule';
import {
  approvalSignature, proposalSignature, readRegularFile, sha256Hex, signedScriptMission, verifyApproval, verifyMissionSig, verifyProposalSig,
  type ApprovedScript, type ScriptMission
} from './scriptAutomation';

export interface ScriptProposal {
  id: string; label: string; description: string; path: string; sha256: string; size: number;
  intervalMs: number; weekly?: { days: number[]; minute: number }; scriptTimeoutMs?: number;
  /** id of a dispatch trigger to switch off on approval */
  replaces?: string;
  /** id of the existing script mission (same label) this proposal updates: new hash + signature, no second row */
  updates?: string;
  proposedBy: string; createdAt: number; sig?: string;
}

/** The slice of a mission the proposal logic reads. */
export interface MissionLike extends ScriptMission { kind?: string; createdBy?: string; enabled?: boolean; to?: string; body?: string }

export interface ProposalHost {
  /** Directory for the pending list and the file copies (0700, outside every agent's reach). */
  dir: string;
  isGod(actor: string): boolean;
  /** Is this one of the app's shipped missions (ops-standup, jira-poll, ...)? They have no kind or createdBy, so only the id tells. */
  isBuiltIn?(id: string): boolean;
  key(create: boolean): string | null;
  missions(): MissionLike[];
  log(event: Record<string, unknown>): void;
  now?: () => number;
}
export interface ProposalResult { status: number; body: unknown }

export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
export const MAX_PENDING = 50;
const MAX_LABEL = 80;
const MAX_DESCRIPTION = 500;
const FIELDS = new Set(['path', 'label', 'description', 'intervalMinutes', 'weekly', 'timeoutSec', 'replaces']);

const fail = (status: number, code: string, error: string): ProposalResult => ({ status, body: { error, code } });
const sameLabel = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
/** Control characters never belong in a label or description (they are shown to the Boss as plain text). */
const clean = (v: unknown, max: number, multiline: boolean): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  // eslint-disable-next-line no-control-regex
  return (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(t) ? null : t;
};

const file = (host: ProposalHost): string => join(host.dir, 'proposals.json');
const copyOf = (host: ProposalHost, id: string): string => join(host.dir, `${id}.copy`);

function ensureDir(host: ProposalHost): void {
  mkdirSync(host.dir, { recursive: true, mode: 0o700 });
  try { chmodSync(host.dir, 0o700); } catch { /* best effort */ }
}
function loadAll(host: ProposalHost): ScriptProposal[] {
  try { const v = JSON.parse(readFileSync(file(host), 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveAll(host: ProposalHost, list: ScriptProposal[]): void {
  ensureDir(host);
  const tmp = `${file(host)}.tmp${process.pid}`;
  writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
  renameSync(tmp, file(host));
}
const dropCopy = (host: ProposalHost, id: string): void => { try { unlinkSync(copyOf(host, id)); } catch { /* gone */ } };

/** A replaced trigger must be a plain dispatch mission that is not an agent's own. */
export function replaceableTrigger(host: ProposalHost, id: unknown, missions: MissionLike[] = host.missions()): string | MissionLike {
  if (typeof id !== 'string' || !id) return 'replaces must be a trigger id';
  const m = missions.find((x) => x.id === id);
  if (!m) return `no trigger "${id}"`;
  if (host.isBuiltIn?.(id)) return 'a built-in trigger cannot be replaced by a proposal';
  if ((m.kind ?? 'dispatch') !== 'dispatch') return 'only a dispatch trigger can be replaced (not a built-in, heartbeat, compact or script one)';
  // Older builds stamped the PTY id ("pty-<agentId>") as creator; strip it so god's own triggers still count as god's.
  if (m.createdBy && !host.isGod(m.createdBy.replace(/^pty-/, '')) && !host.isGod(m.createdBy)) return 'that trigger belongs to another agent and cannot be switched off by a proposal';
  return m;
}

export function propose(host: ProposalHost, actor: string, raw: unknown): ProposalResult {
  if (!host.isGod(actor)) return fail(403, 'forbidden', 'only god may propose a script');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, 'bad_request', 'body must be a JSON object');
  const r = raw as Record<string, unknown>;
  const unknown = Object.keys(r).filter((k) => !FIELDS.has(k));
  if (unknown.length) return fail(400, 'bad_request', `unknown field(s): ${unknown.join(', ')}`);

  const label = clean(r.label, MAX_LABEL, false);
  if (!label) return fail(400, 'bad_request', `label must be 1-${MAX_LABEL} printable characters`);
  const description = clean(r.description, MAX_DESCRIPTION, true);
  if (!description) return fail(400, 'bad_request', `description must be 1-${MAX_DESCRIPTION} characters`);

  const hasInterval = r.intervalMinutes !== undefined && r.intervalMinutes !== null;
  const hasWeekly = r.weekly !== undefined && r.weekly !== null;
  if (hasInterval === hasWeekly) return fail(400, 'bad_request', 'give exactly one of intervalMinutes or weekly');
  let intervalMs = 86_400_000; // a weekly mission keeps a day-long interval, like the agent automations
  let weekly: ScriptProposal['weekly'];
  if (hasInterval) {
    const n = r.intervalMinutes;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < MIN_INTERVAL_MINUTES || n > MAX_INTERVAL_MINUTES) {
      return fail(400, 'bad_request', `intervalMinutes must be an integer ${MIN_INTERVAL_MINUTES}-${MAX_INTERVAL_MINUTES}`);
    }
    intervalMs = n * 60_000;
  } else {
    const w = normalizeWeekly(r.weekly);
    if (!w) return fail(400, 'bad_request', 'weekly must be { days: [0-6, 0=Sunday], minute: 0-1439 }');
    weekly = w;
  }
  let scriptTimeoutMs: number | undefined;
  if (r.timeoutSec !== undefined && r.timeoutSec !== null) {
    const t = r.timeoutSec;
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > 600) return fail(400, 'bad_request', 'timeoutSec must be an integer 1-600');
    scriptTimeoutMs = t * 1000;
  }
  let replaces: string | undefined;
  if (r.replaces !== undefined && r.replaces !== null) {
    const m = replaceableTrigger(host, r.replaces);
    if (typeof m === 'string') return fail(403, 'forbidden', m);
    replaces = m.id;
  }

  // The file: absolute path, real path, ONE bounded non-blocking read, must be a script.
  if (typeof r.path !== 'string' || !isAbsolute(r.path) || r.path.length > 1024 || r.path.includes('\0')) {
    return fail(400, 'bad_request', 'path must be an absolute file path');
  }
  let path: string; let bytes: Buffer;
  try { path = realpathSync(r.path); bytes = readRegularFile(path); } catch (e) {
    return fail(400, 'bad_file', `cannot read the script as a regular file (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (bytes.length === 0 || bytes[0] !== 0x23 || bytes[1] !== 0x21) return fail(400, 'bad_file', 'the script must start with a #! line');

  const key = host.key(true);
  if (!key) return fail(503, 'no_key', 'the macOS Keychain (safeStorage) is not available');
  const now = (host.now ?? Date.now)();
  const all = loadAll(host);
  const same = all.filter((p) => sameLabel(p.label, label));
  const others = all.filter((p) => !sameLabel(p.label, label));
  if (others.length >= MAX_PENDING) return fail(429, 'cap_reached', `at most ${MAX_PENDING} pending proposals`);
  const existing = host.missions().find((m) => m.kind === 'script' && sameLabel(m.label, label));
  const rec: ScriptProposal = {
    id: `p_${now.toString(36)}${randomBytes(3).toString('hex')}`, label, description, path, sha256: sha256Hex(bytes), size: bytes.length,
    intervalMs, ...(weekly ? { weekly } : {}), ...(scriptTimeoutMs ? { scriptTimeoutMs } : {}),
    ...(replaces ? { replaces } : {}), ...(existing ? { updates: existing.id } : {}), proposedBy: actor, createdAt: now
  };
  rec.sig = proposalSignature(key, rec);
  ensureDir(host);
  writeFileSync(copyOf(host, rec.id), bytes, { mode: 0o600, flag: 'wx' });
  for (const old of same) dropCopy(host, old.id); // a new proposal for the same label replaces the pending one
  saveAll(host, [...others, rec]);
  host.log({ kind: 'script-proposed', id: rec.id, label, sha256: rec.sha256, replaces, updates: rec.updates, by: actor });
  return { status: 201, body: { id: rec.id, label, sha256: rec.sha256, updates: rec.updates ?? null, replaces: replaces ?? null, status: 'pending approval by the Boss' } };
}

/** What the Settings screen shows. The file content is the stored COPY the Boss is approving; it is untrusted text. */
export interface ProposalView extends Omit<ScriptProposal, 'sig'> { content: string; intact: boolean; replacesLabel?: string; updatesLabel?: string }

export function listProposals(host: ProposalHost): ProposalView[] {
  const key = host.key(false);
  const missions = host.missions();
  const out: ProposalView[] = [];
  for (const p of loadAll(host)) {
    if (!verifyProposalSig(key, p)) { host.log({ kind: 'script-proposal-invalid', id: p?.id }); continue; }
    let content = ''; let intact = false;
    try { const b = readRegularFile(copyOf(host, p.id)); content = b.toString('utf8'); intact = sha256Hex(b) === p.sha256; } catch { /* missing copy */ }
    const { sig: _s, ...view } = p;
    out.push({
      ...view, content, intact,
      replacesLabel: p.replaces ? missions.find((m) => m.id === p.replaces)?.label : undefined,
      updatesLabel: p.updates ? missions.find((m) => m.id === p.updates)?.label : undefined
    });
  }
  return out;
}

export function rejectProposal(host: ProposalHost, id: string): boolean {
  const all = loadAll(host);
  if (!all.some((p) => p.id === id)) return false;
  saveAll(host, all.filter((p) => p.id !== id));
  dropCopy(host, id);
  host.log({ kind: 'script-proposal-rejected', id });
  return true;
}

export interface ApprovalConfig { approvedScripts: ApprovedScript[]; missions: MissionLike[] }
export type ApproveResult = { ok: true; approvedScripts: ApprovedScript[]; missions: MissionLike[]; label: string; replaced?: string } | { ok: false; error: string };

/** Everything the click does, computed in memory from STORED data. The caller writes the result in one config write
 *  and then calls `finishApproval`. A failure at any step returns an error and changes nothing. */
export function approveProposal(host: ProposalHost, id: string, cfg: ApprovalConfig): ApproveResult {
  const key = host.key(true);
  if (!key) return { ok: false, error: 'the macOS Keychain (safeStorage) is not available' };
  const p = loadAll(host).find((x) => x.id === id);
  if (!p) return { ok: false, error: 'no such proposal (it may have been replaced or rejected)' };
  if (!verifyProposalSig(key, p)) return { ok: false, error: 'the stored proposal is not authentic' };
  let copy: Buffer; let current: Buffer;
  try { copy = readRegularFile(copyOf(host, id)); } catch { return { ok: false, error: 'the stored copy of the script is missing' }; }
  if (sha256Hex(copy) !== p.sha256) return { ok: false, error: 'the stored copy changed since it was proposed' };
  try { current = readRegularFile(p.path); } catch { return { ok: false, error: 'the script file cannot be read any more' }; }
  if (sha256Hex(current) !== p.sha256) return { ok: false, error: 'the script file changed after it was proposed: ask for a new proposal' };

  const now = (host.now ?? Date.now)();
  const missions = [...cfg.missions];
  let approvedScripts = [...cfg.approvedScripts];
  let replaced: string | undefined;
  if (p.replaces) {
    const m = replaceableTrigger(host, p.replaces, missions);
    if (typeof m === 'string') return { ok: false, error: `cannot switch off the replaced trigger: ${m}` };
    replaced = m.label;
    missions[missions.findIndex((x) => x.id === m.id)] = { ...m, enabled: false };
  }
  // Update in place when this label already has a script mission (and its approval still verifies): same row, new hash.
  const existing = p.updates ? missions.find((m) => m.id === p.updates && m.kind === 'script') : undefined;
  let scriptId: string; let missionId: string; let enabled = true;
  if (existing) {
    if (!verifyMissionSig(key, existing)) return { ok: false, error: 'the existing script mission is not authentic: delete it and approve again' };
    scriptId = String(existing.scriptId); missionId = existing.id; enabled = existing.enabled !== false;
  } else {
    const byPath = approvedScripts.find((a) => a.path === p.path);
    scriptId = byPath?.id ?? `s_${now.toString(36)}`; missionId = `m_${now.toString(36)}`;
  }
  const base = { id: scriptId, path: p.path, sha256: p.sha256, approvedAt: now };
  const entry: ApprovedScript = { ...base, sig: approvalSignature(key, base) };
  approvedScripts = approvedScripts.some((a) => a.id === scriptId) ? approvedScripts.map((a) => (a.id === scriptId ? entry : a)) : [...approvedScripts, entry];
  const rec = signedScriptMission(key, {
    id: missionId, label: p.label, scriptId, intervalMs: p.intervalMs, weekly: p.weekly, scriptTimeoutMs: p.scriptTimeoutMs,
    enabled, lastFiredAt: existing?.lastFiredAt ?? now
  });
  const at = missions.findIndex((m) => m.id === missionId);
  if (at >= 0) missions[at] = rec; else missions.push(rec);
  if (!verifyApproval(key, entry) || !verifyMissionSig(key, rec)) return { ok: false, error: 'internal: signatures do not verify' };
  return { ok: true, approvedScripts, missions, label: p.label, replaced };
}

/** After the config write succeeded: the proposal is consumed. */
export function finishApproval(host: ProposalHost, id: string, summary: Record<string, unknown>): void {
  saveAll(host, loadAll(host).filter((p) => p.id !== id));
  dropCopy(host, id);
  host.log({ kind: 'script-proposal-approved', id, ...summary });
}
export const proposalCopyExists = (host: ProposalHost, id: string): boolean => existsSync(copyOf(host, id));

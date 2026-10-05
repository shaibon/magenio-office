/**
 * AGENT AUTOMATIONS — the rules behind `/automations` on the loopback broker.
 *
 * An agent holding a broker capability may list, create, update and delete
 * scheduled triggers (the `schedules` kind: recurring dispatched missions owned
 * by config.missions). Every write goes through the validation here, so the broker
 * route is a thin transport and the rules are testable without a server.
 *
 * Pure and electron-free on purpose; the host supplies storage and the roster.
 */
import { normalizeWeekly } from './weeklySchedule';

/** The slice of a stored mission this module reads and writes. The host's
 *  `ScheduledMission` is a structural superset, so records round-trip untouched. */
export interface AutomationRecord {
  id: string;
  label: string;
  intervalMs: number;
  weekly?: { days: number[]; minute: number };
  to: string;
  body: string;
  enabled: boolean;
  lastFiredAt?: number;
  kind?: 'dispatch' | 'heartbeat' | 'compact';
  /** Agent id that created the trigger. Absent on operator and built-in ones. */
  createdBy?: string;
}

export interface AutomationHost {
  list(): AutomationRecord[];
  /** Persist, re-arm the scheduler and tell the UI to refresh. */
  save(next: AutomationRecord[]): void;
  /** Target check: a registered agent id, or 'god' / 'broadcast'. */
  targetExists(id: string): boolean;
  isGod(agentId: string): boolean;
  log(event: Record<string, unknown>): void;
  now?: () => number;
}

export interface AutomationResult { status: number; body: unknown }

export const MAX_AUTOMATIONS_PER_AGENT = 10;
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const MAX_LABEL = 80;
const MAX_BODY = 4000;

const fail = (status: number, code: string, error: string): AutomationResult => ({ status, body: { error, code } });
const ok = (body: unknown, status = 200): AutomationResult => ({ status, body });

/** What an agent sees. `owner` is null for operator-made and built-in triggers. */
function publicView(m: AutomationRecord): Record<string, unknown> {
  return {
    id: m.id, label: m.label, to: m.to, body: m.body, enabled: m.enabled, kind: m.kind ?? 'dispatch',
    intervalMinutes: m.intervalMs > 0 ? Math.round(m.intervalMs / 60_000) : null,
    weekly: normalizeWeekly(m.weekly), lastFiredAt: m.lastFiredAt ?? null, owner: m.createdBy ?? null
  };
}

const CREATE_KEYS = new Set(['label', 'body', 'to', 'intervalMinutes', 'weekly', 'enabled']);

/** Validate the writable fields. `partial` (update) tolerates absent fields;
 *  create requires label, body, to and exactly one schedule shape. */
function parseFields(raw: unknown, partial: boolean): { fields: Partial<AutomationRecord> & { clearWeekly?: boolean }; error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { fields: {}, error: 'body must be a JSON object' };
  const r = raw as Record<string, unknown>;
  const unknown = Object.keys(r).filter((k) => !CREATE_KEYS.has(k));
  if (unknown.length) return { fields: {}, error: `unknown field(s): ${unknown.join(', ')}` };
  const f: Partial<AutomationRecord> & { clearWeekly?: boolean } = {};

  if ('label' in r || !partial) {
    const label = typeof r.label === 'string' ? r.label.trim() : '';
    if (!label || label.length > MAX_LABEL) return { fields: {}, error: `label must be 1-${MAX_LABEL} characters` };
    f.label = label;
  }
  if ('body' in r || !partial) {
    const body = typeof r.body === 'string' ? r.body.trim() : '';
    if (!body || body.length > MAX_BODY) return { fields: {}, error: `body must be 1-${MAX_BODY} characters` };
    f.body = body;
  }
  if ('to' in r || !partial) {
    if (typeof r.to !== 'string' || !r.to.trim()) return { fields: {}, error: 'to must be an agent id' };
    f.to = r.to.trim();
  }
  if ('enabled' in r) {
    if (typeof r.enabled !== 'boolean') return { fields: {}, error: 'enabled must be a boolean' };
    f.enabled = r.enabled;
  }
  const hasInterval = r.intervalMinutes !== undefined && r.intervalMinutes !== null;
  const hasWeekly = r.weekly !== undefined && r.weekly !== null;
  if (hasInterval && hasWeekly) return { fields: {}, error: 'give intervalMinutes or weekly, not both' };
  if (!partial && !hasInterval && !hasWeekly) return { fields: {}, error: 'give intervalMinutes or weekly' };
  if (hasInterval) {
    const n = r.intervalMinutes;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < MIN_INTERVAL_MINUTES || n > MAX_INTERVAL_MINUTES) {
      return { fields: {}, error: `intervalMinutes must be an integer ${MIN_INTERVAL_MINUTES}-${MAX_INTERVAL_MINUTES}` };
    }
    f.intervalMs = n * 60_000;
    f.clearWeekly = true;
  }
  if (hasWeekly) {
    // Same validator the scheduler arms from, so what is accepted here is what runs.
    const w = normalizeWeekly(r.weekly);
    if (!w) return { fields: {}, error: 'weekly must be { days: [0-6, 0=Sunday], minute: 0-1439 }' };
    f.weekly = w;
  }
  return { fields: f };
}

export function listAutomations(host: AutomationHost): AutomationResult {
  return ok({ automations: host.list().map(publicView) });
}

export function createAutomation(host: AutomationHost, actor: string, raw: unknown): AutomationResult {
  const { fields, error } = parseFields(raw, false);
  if (error) return fail(400, 'bad_request', error);
  if (!host.targetExists(fields.to!)) return fail(400, 'unknown_target', `no agent "${fields.to}"`);
  const all = host.list();
  if (all.filter((m) => m.createdBy === actor).length >= MAX_AUTOMATIONS_PER_AGENT) {
    return fail(429, 'cap_reached', `at most ${MAX_AUTOMATIONS_PER_AGENT} automations per agent; delete one first`);
  }
  const now = (host.now ?? Date.now)();
  const slug = fields.label!.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'run';
  const rec: AutomationRecord = {
    id: `agent-${slug}-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    label: fields.label!, to: fields.to!, body: fields.body!,
    // A weekly record keeps a day-long interval so switching back in the UI restores a sane cadence.
    intervalMs: fields.intervalMs ?? 86_400_000,
    enabled: fields.enabled ?? true,
    kind: 'dispatch',
    createdBy: actor,
    // Stamp "now" so the scheduler waits a full period instead of firing on the spot.
    lastFiredAt: now
  };
  if (fields.weekly) rec.weekly = fields.weekly;
  host.save([...all, rec]);
  host.log({ kind: 'automation-create', actor, id: rec.id, label: rec.label, to: rec.to });
  return ok(publicView(rec), 201);
}

/** null = may touch it. Heartbeat/compact are app machinery, never editable here. */
function guard(host: AutomationHost, actor: string, m: AutomationRecord): AutomationResult | null {
  if ((m.kind ?? 'dispatch') !== 'dispatch') return fail(403, 'forbidden', 'built-in system trigger');
  if (m.createdBy !== actor && !host.isGod(actor)) return fail(403, 'forbidden', 'not your automation (only its owner or god may change it)');
  return null;
}

export function updateAutomation(host: AutomationHost, actor: string, id: string, raw: unknown): AutomationResult {
  const all = host.list();
  const cur = all.find((m) => m.id === id);
  if (!cur) return fail(404, 'not_found', 'unknown automation');
  const denied = guard(host, actor, cur);
  if (denied) return denied;
  const { fields, error } = parseFields(raw, true);
  if (error) return fail(400, 'bad_request', error);
  if (fields.to !== undefined && !host.targetExists(fields.to)) return fail(400, 'unknown_target', `no agent "${fields.to}"`);
  const { clearWeekly, ...patch } = fields;
  const next: AutomationRecord = { ...cur, ...patch };
  if (clearWeekly) delete next.weekly;
  host.save(all.map((m) => (m.id === id ? next : m)));
  host.log({ kind: 'automation-update', actor, id, fields: Object.keys(patch) });
  return ok(publicView(next));
}

export function deleteAutomation(host: AutomationHost, actor: string, id: string): AutomationResult {
  const all = host.list();
  const cur = all.find((m) => m.id === id);
  if (!cur) return fail(404, 'not_found', 'unknown automation');
  const denied = guard(host, actor, cur);
  if (denied) return denied;
  host.save(all.filter((m) => m.id !== id));
  host.log({ kind: 'automation-delete', actor, id, label: cur.label });
  return ok({ id, deleted: true });
}

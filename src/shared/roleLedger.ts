/**
 * t-056 (review fix) — the PRIVILEGED role ledger.
 *
 * Why this module exists at all. Before this, the role that decides whether an
 * agent gets the integration-broker token or the role-scoped Trello server was
 * re-read at spawn from `registry.json`, inside the hive root — and the hive
 * root is one of `HiveManager.sandboxWritableDirs()`' entries, i.e. a file the
 * agents themselves can write. An agent that wrote `role: PM` into its own
 * registry entry became a PM on the next restart and was handed Trello (read)
 * and, plausibly, a broker token. `registry.json` is display state; it must
 * never be the source of a privilege.
 *
 * So privilege is granted from THIS ledger instead: a tiny map of agentId →
 * role string, stored by the main process in the Electron userData directory,
 * which is deliberately NOT in any agent's writable set. Nothing in the ledger
 * is derived from a file an agent can reach.
 *
 * Recording rules (see HiveManager.rememberPrivilegedRole):
 *   - a role is recorded ONCE per agent id, from the role the SPAWN REQUEST
 *     carried (the app's own statement of who it just started) — never from the
 *     registry fallback;
 *   - an id that already has an entry is never overwritten by a later spawn, so
 *     a registry edit after the fact is inert: there is nothing left for it to
 *     influence;
 *   - only durable roles are recorded (`isDurableRole`) — a "standby" caption is
 *     run state, not a job, and must not become a privilege.
 *
 * Pure module: no fs, no electron, so both the main process and the tests can
 * load it (mirrors the other `src/shared` helpers).
 */

import { isDurableRole } from './agentRole';

export interface RoleLedger {
  /** Bumped only if the on-disk shape changes incompatibly. */
  version: 1;
  /** agentId → the durable role the app recorded for it. */
  roles: Record<string, string>;
}

export function emptyRoleLedger(): RoleLedger {
  return { version: 1, roles: {} };
}

/** Tolerant reader: a missing, truncated, hand-edited or foreign-shaped file
 *  must never throw at spawn time — it degrades to an EMPTY ledger (no role, so
 *  no privilege; fail-closed), never to a permissive one. */
export function normalizeRoleLedger(raw: unknown): RoleLedger {
  const out = emptyRoleLedger();
  if (!raw || typeof raw !== 'object') return out;
  const roles = (raw as { roles?: unknown }).roles;
  if (!roles || typeof roles !== 'object') return out;
  for (const [id, role] of Object.entries(roles as Record<string, unknown>)) {
    if (typeof id !== 'string' || !id) continue;
    if (typeof role !== 'string') continue;
    const value = role.trim();
    if (!isDurableRole(value)) continue;
    out.roles[id] = value;
  }
  return out;
}

/** The role this ledger holds for an agent ('' when it holds none). */
export function ledgerRole(ledger: RoleLedger | null | undefined, agentId: string): string {
  return ledger?.roles?.[agentId] ?? '';
}

/** Record a role for an agent. Returns true when the ledger changed.
 *
 *  `onlyIfAbsent` (the spawn path's rule) keeps the FIRST app-recorded role: an
 *  id that already has an entry is never rewritten, which is what makes a later
 *  edit to agent-writable display state incapable of promoting anybody. */
export function rememberLedgerRole(
  ledger: RoleLedger,
  agentId: string,
  role: string | undefined | null,
  opts: { onlyIfAbsent?: boolean } = {}
): boolean {
  const value = (role ?? '').trim();
  if (!agentId || !isDurableRole(value)) return false;
  if (opts.onlyIfAbsent && ledgerRole(ledger, agentId)) return false;
  if (ledgerRole(ledger, agentId) === value) return false;
  ledger.roles[agentId] = value;
  return true;
}

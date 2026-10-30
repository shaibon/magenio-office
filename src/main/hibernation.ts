/**
 * Agent hibernation (t-279, phase 2a) — the pure decision + wake-concurrency pieces.
 *
 * Hibernating an agent closes its CLI process (and the MCP servers under it) but keeps
 * everything that makes it *that* agent: registry row, memory, inbox, session id,
 * worktree. It is neither `archived` (gone from the roster) nor `frozen` (process alive,
 * delivery refused): a hibernated agent stays AVAILABLE and any direct event wakes it.
 *
 * No electron import — unit-testable, like workerWake.ts / control.ts.
 */

/** Everything the reaper knows about one agent at decision time. */
export interface HibernateFacts {
  agentId: string;
  isGod: boolean;
  /** Ephemeral god-hired worker (reaped by its own lifecycle, never hibernated). */
  isWorker: boolean;
  onHold: boolean;
  /** ControlRegistry flags. */
  autoDeliveryPaused: boolean;
  paused: boolean;
  halted: boolean;
  /** Live PTY id; undefined = nothing to hibernate. */
  ptyId?: string;
  /** Spawn recipe captured at spawn time (without it there is nothing to wake with). */
  hasRecipe: boolean;
  /** Recorded CLI session id valid for the agent's provider (the resume key). */
  hasSession: boolean;
  /** Epoch ms of the PTY's last output (0 = never). */
  lastOutputAt: number;
  /** Epoch ms the PTY was spawned (0 = unknown). */
  spawnedAt: number;
  /** Last turn hook was a Stop (the CLI is parked at its prompt, not mid-turn). */
  lastTurnWasStop: boolean;
  /** A permission/HITL prompt fired recently (a human may be deciding on it). */
  hitlRecently: boolean;
  /** Undrained inbox messages. */
  inboxCount: number;
  /** tasks.json cards assigned to the agent with status `doing`. `blocked` / `review`
   *  deliberately do NOT count: those wait on a human/reviewer, not on this agent. */
  doingCards: number;
}

export interface HibernateConfig {
  /** Minutes of inactivity before hibernation; 0/undefined = feature off. */
  minutes: number;
  /** Phase 2a is opt-in: only these agent ids may hibernate. */
  optIn: readonly string[];
}

/** Why an agent is NOT hibernated right now (null from holdReason = go ahead). */
export type HibernateHold =
  | 'off' | 'not-opted-in' | 'god' | 'worker' | 'on-hold' | 'frozen' | 'paused' | 'halted'
  | 'no-pty' | 'no-recipe' | 'no-session' | 'booting' | 'recent-output' | 'mid-turn'
  | 'hitl' | 'inbox' | 'doing-card';

/** A PTY that has never printed is still booting; spawn time bounds that. */
export const HIBERNATE_BOOT_GRACE_MS = 60_000;

/** Pure: the first reason this agent must stay awake, or null when it may hibernate.
 *  Order matters only for the reported reason; every rule is a hard stop. */
export function holdReason(f: HibernateFacts, cfg: HibernateConfig, now = Date.now()): HibernateHold | null {
  if (!(cfg.minutes > 0)) return 'off';
  if (!cfg.optIn.includes(f.agentId)) return 'not-opted-in';
  if (f.isGod) return 'god';
  if (f.isWorker) return 'worker';
  if (f.onHold) return 'on-hold';
  if (f.autoDeliveryPaused) return 'frozen';
  if (f.paused) return 'paused';
  if (f.halted) return 'halted';
  if (!f.ptyId) return 'no-pty';
  if (!f.hasRecipe) return 'no-recipe';
  // Without a recorded session a wake would start blank: lose the context we exist to keep.
  if (!f.hasSession) return 'no-session';
  if (f.spawnedAt > 0 && now - f.spawnedAt < HIBERNATE_BOOT_GRACE_MS) return 'booting';
  const last = Math.max(f.lastOutputAt, f.spawnedAt);
  if (last <= 0 || now - last < cfg.minutes * 60_000) return 'recent-output';
  if (!f.lastTurnWasStop) return 'mid-turn';
  if (f.hitlRecently) return 'hitl';
  if (f.inboxCount > 0) return 'inbox';
  if (f.doingCards > 0) return 'doing-card';
  return null;
}

/** Count `doing` cards assigned to an agent in a tasks.json ledger. */
export function countDoingCards(ledger: unknown, agentId: string): number {
  const tasks = (ledger as { tasks?: Array<{ assignee?: string; status?: string }> } | null)?.tasks;
  if (!Array.isArray(tasks)) return 0;
  return tasks.filter((t) => t?.assignee === agentId && t?.status === 'doing').length;
}

/**
 * Wake coordination: ONE spawn per agent however many events arrive at once (idempotent,
 * per-agent lock), and at most `max` spawns in flight (thundering-herd limit when many
 * sleepers receive mail together, e.g. after a broadcast).
 */
export class WakeGate {
  private inFlight = new Map<string, Promise<boolean>>();
  private running = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly max = 3) {}

  /** Run `task` for `agentId` unless one is already in flight (then share its result). */
  run(agentId: string, task: () => Promise<boolean>): Promise<boolean> {
    const existing = this.inFlight.get(agentId);
    if (existing) return existing;
    const p = (async () => {
      await this.acquire();
      try { return await task(); } catch { return false; } finally { this.release(); }
    })().finally(() => { this.inFlight.delete(agentId); });
    this.inFlight.set(agentId, p);
    return p;
  }

  isWaking(agentId: string): boolean { return this.inFlight.has(agentId); }

  private acquire(): Promise<void> {
    if (this.running < this.max) { this.running++; return Promise.resolve(); }
    return new Promise((resolve) => { this.waiters.push(() => { this.running++; resolve(); }); });
  }
  private release(): void {
    this.running--;
    this.waiters.shift()?.();
  }
}

/** What the lifecycle needs from the app; index.ts wires the real ones, tests wire fakes. */
export interface HibernatorDeps<Recipe> {
  /** Live pty id of an agent, if any. */
  ptyFor(agentId: string): string | undefined;
  recipeFor(agentId: string): Recipe | undefined;
  /** The agent's recorded resume key for its provider. */
  sessionFor(agentId: string): string | undefined;
  isHibernated(agentId: string): boolean;
  /** Registry/fleet/log write; must report failure so we never kill without the flag. */
  setHibernated(agentId: string, on: boolean, info?: { sessionId?: string; reason?: string }): boolean;
  /** Kill the pty AND its MCP tree (no archive, no worktree removal). */
  killPty(ptyId: string): boolean;
  /** Light teardown: revoke capabilities, forget watchdog state. NOT archive, NOT worktree. */
  teardownLight(ptyId: string): void;
  /** Re-spawn from the recipe with the session resumed; true when the process started. */
  respawn(agentId: string, recipe: Recipe, reason: string): Promise<boolean>;
  /** Terminal/UI side effects (a notice in the terminal, the floor event). */
  notify(agentId: string, ptyId: string, hibernated: boolean, recipe: Recipe | undefined): void;
  /** Undrained mail now. */
  inboxCount(agentId: string): number;
}

export class Hibernator<Recipe> {
  /** pty id → agent id for sleepers (their pty no longer exists to map back). */
  readonly sleepers = new Map<string, string>();
  constructor(readonly d: HibernatorDeps<Recipe>, private readonly gate = new WakeGate(3)) {}

  /** Close an idle agent but keep it. False = it stays awake (nothing was touched). */
  hibernate(agentId: string, reason: string): boolean {
    const ptyId = this.d.ptyFor(agentId);
    const recipe = this.d.recipeFor(agentId);
    if (!ptyId || !recipe || this.d.isHibernated(agentId) || this.isSleeper(agentId)) return false;
    const sessionId = this.d.sessionFor(agentId);
    if (!sessionId) return false; // a wake would start blank — never trade context for memory
    // Flag first, then kill: the wake beat and the write guard see the sleeper from here on.
    if (!this.d.setHibernated(agentId, true, { sessionId, reason })) return false;
    this.sleepers.set(ptyId, agentId);
    // A kill that failed leaves the process (and the pty session) alive: undo everything so the
    // agent is simply still awake — no light teardown, no stale flag, no phantom sleeper.
    if (!this.d.killPty(ptyId)) {
      this.sleepers.delete(ptyId);
      this.d.setHibernated(agentId, false, { reason: 'kill-failed' });
      return false;
    }
    this.d.teardownLight(ptyId);
    this.d.notify(agentId, ptyId, true, recipe);
    // Race: mail that landed while we were closing must not wait for the next beat.
    if (this.d.inboxCount(agentId) > 0) void this.wake(agentId, 'mail-during-hibernate');
    return true;
  }

  /** Idempotent, rate-limited wake. Authority is the in-process sleeper record, NOT the registry
   *  flag: agents can write registry.json, so a flag on its own (forged for a live peer, or left
   *  over from a previous run) never causes a respawn — it is cleared instead. */
  wake(agentId: string, reason: string): Promise<boolean> {
    return this.gate.run(agentId, async () => {
      const flagged = this.d.isHibernated(agentId);
      if (!this.isSleeper(agentId) || this.d.ptyFor(agentId)) {
        // A live pty means the record is stale: drop it, or the write guard keeps swallowing input.
        this.forget(agentId);
        if (flagged) this.d.setHibernated(agentId, false, { reason: 'inconsistent-flag' });
        return false;
      }
      // A recorded sleeper with no live pty is the one authoritative case. The registry flag is
      // peer-writable, so a MISSING flag is repaired here rather than allowed to strand the agent.
      if (!flagged) this.d.setHibernated(agentId, true, { reason: 'flag-repaired' });
      const recipe = this.d.recipeFor(agentId);
      if (!recipe) { this.forget(agentId); this.d.setHibernated(agentId, false, { reason: 'no-recipe' }); return false; }
      const ok = await this.d.respawn(agentId, recipe, reason);
      if (ok) {
        this.forget(agentId);
        this.d.notify(agentId, '', false, recipe);
      }
      return ok;
    });
  }

  /** Drop the sleeper record (the agent was woken, respawned, or closed for good). */
  forget(agentId: string): void {
    for (const [pty, a] of this.sleepers) if (a === agentId) this.sleepers.delete(pty);
  }

  isSleeper(agentId: string): boolean {
    for (const a of this.sleepers.values()) if (a === agentId) return true;
    return false;
  }

  /** Agent that owns a sleeping pty id, if any (the terminal-input guard). */
  sleeperOf(ptyId: string): string | undefined { return this.sleepers.get(ptyId); }
}

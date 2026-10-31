import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Main-owned record of which agents the APP put to sleep (t-283, security L2). `registry.json` is
 *  writable by every agent, so its `hibernated` flag alone must not decide that an agent boots
 *  asleep. This file lives under userData, outside any agent-writable root: hive root → agent id →
 *  the session id it slept with. Corrupt or foreign content reads as "nobody is asleep". */
export class SleepMarker {
  constructor(private readonly file: string, private readonly root: () => string | null) {}

  private read(): Record<string, Record<string, string>> {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch { return {}; }
  }

  private write(all: Record<string, Record<string, string>>): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch { /* best-effort: without the marker the agent simply boots awake */ }
  }

  set(agentId: string, sessionId: string): void {
    const root = this.root();
    if (!root || !agentId) return;
    const all = this.read();
    const mine = Object.hasOwn(all, root) && all[root] && typeof all[root] === 'object' ? all[root] : {};
    mine[agentId] = sessionId;
    all[root] = mine;
    this.write(all);
  }

  clear(agentId: string): void {
    const root = this.root();
    if (!root) return;
    const all = this.read();
    if (!Object.hasOwn(all, root) || !all[root] || !Object.hasOwn(all[root], agentId)) return;
    delete all[root][agentId];
    this.write(all);
  }

  /** The session id the app recorded when it put this agent to sleep, if it did. */
  sessionOf(agentId: string): string | undefined {
    const root = this.root();
    if (!root) return undefined;
    const all = this.read();
    if (!Object.hasOwn(all, root) || !all[root] || !Object.hasOwn(all[root], agentId)) return undefined;
    const v = all[root][agentId];
    return typeof v === 'string' && v ? v : undefined;
  }
}

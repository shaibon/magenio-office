/**
 * Temp History — the past and present of ephemeral workers (`worker-*`), folded
 * from records the app already keeps. Pure: main gathers the raw records
 * (tempHistory read in index.ts) and hands them here, so the aggregation can be
 * tested without electron or a hive on disk.
 */

export type TempStatus = 'running' | 'done' | 'failed' | 'killed' | 'preserved-worktree';
export type TempRange = '24h' | '7d' | 'all';

/** One spawn-request file: where it ended up says whether the spawn was accepted. */
export interface TempRequest {
  /** Worker id the request maps to (`worker-<reqId>`). */
  workerId: string;
  state: 'pending' | 'done' | 'failed';
  /** File mtime — the closest thing to "when the request was handled". */
  at: number;
  name?: string;
  objective?: string;
  cwd?: string;
}

/** The slice of log.jsonl events this view reads. */
export interface TempLogEvent {
  ts: number;
  kind: string;
  agentId?: string;
  archived?: boolean;
  abnormal?: boolean;
}

export interface TempRegistryEntry {
  name?: string;
  cwd?: string;
  project?: string;
  lastSeen?: number;
}

export interface TempHistoryInput {
  now: number;
  requests: TempRequest[];
  log: TempLogEvent[];
  registry: Record<string, TempRegistryEntry>;
  /** workerId → ts of its terminal `act:"done"` message. */
  doneAt: Record<string, number>;
  /** workerId → lifetime tokens / usd (cost ledger). */
  usage: Record<string, { tokens: number; usd: number }>;
  /** Workers whose worktree is still on disk, kept because it holds unintegrated work. */
  worktreeKept: string[];
  /** Workers with a live pty right now. */
  live: string[];
  tasks: { id: string; assignee?: string | null }[];
}

export interface TempRow {
  workerId: string;
  name: string;
  /** First line of the spawn-request objective; '' when the request is gone. */
  objective: string;
  project: string;
  cwd: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  tokens: number;
  usd: number;
  status: TempStatus;
  taskId: string | null;
}

export interface TempFilter {
  /** '' = every project. */
  project: string;
  /** '' = every status. */
  status: TempStatus | '';
  range: TempRange;
}

export interface TempTotals { count: number; tokens: number; usd: number }

const RANGE_MS: Record<TempRange, number> = { '24h': 24 * 3600_000, '7d': 7 * 24 * 3600_000, all: Infinity };

export function firstLine(s: string | undefined): string {
  return (s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

export function buildTempHistory(inp: TempHistoryInput): TempRow[] {
  const ids = new Set<string>();
  for (const r of inp.requests) ids.add(r.workerId);
  for (const id of Object.keys(inp.registry)) if (id.startsWith('worker-')) ids.add(id);
  for (const e of inp.log) if (e.agentId?.startsWith('worker-')) ids.add(e.agentId);

  const live = new Set(inp.live);
  const kept = new Set(inp.worktreeKept);
  const rows: TempRow[] = [];

  for (const id of ids) {
    const req = inp.requests.find((r) => r.workerId === id);
    const reg = inp.registry[id];
    const events = inp.log.filter((e) => e.agentId === id);
    const spawns = events.filter((e) => e.kind === 'spawn').map((e) => e.ts);
    const archives = events.filter((e) => e.kind === 'archive' && e.archived).map((e) => e.ts);
    const lastSpawn = spawns.length ? Math.max(...spawns) : 0;
    const lastArchive = archives.length ? Math.max(...archives) : 0;
    const done = inp.doneAt[id];
    const crashed = events.some((e) => e.kind === 'agent-exit' && e.abnormal);

    // A rejected request never produced a worker: it "started" and "ended" when handled.
    const rejected = req?.state === 'failed';
    const startedAt = spawns.length ? Math.min(...spawns) : (req?.at ?? reg?.lastSeen ?? 0);
    const running = !rejected && (live.has(id) || lastSpawn > lastArchive);
    const endedAt = running ? null
      : rejected ? (req?.at ?? startedAt)
      : (lastArchive || done || reg?.lastSeen || null);

    let status: TempStatus;
    if (running) status = 'running';
    else if (rejected || (crashed && !done)) status = 'failed';
    else if (kept.has(id)) status = 'preserved-worktree';
    else if (done) status = 'done';
    else status = 'killed';

    const u = inp.usage[id];
    rows.push({
      workerId: id,
      name: req?.name || reg?.name || id,
      objective: firstLine(req?.objective),
      project: reg?.project ?? '',
      cwd: reg?.cwd ?? req?.cwd ?? '',
      startedAt,
      endedAt,
      durationMs: Math.max(0, (endedAt ?? inp.now) - startedAt),
      tokens: u?.tokens ?? 0,
      usd: u?.usd ?? 0,
      status,
      taskId: inp.tasks.find((t) => t.assignee === id)?.id ?? null
    });
  }
  return rows.sort((a, b) => b.startedAt - a.startedAt);
}

export function filterTempHistory(rows: TempRow[], f: TempFilter, now: number): TempRow[] {
  const since = now - RANGE_MS[f.range];
  return rows.filter((r) =>
    (!f.project || r.project === f.project)
    && (!f.status || r.status === f.status)
    && r.startedAt >= since);
}

export function totalTempHistory(rows: TempRow[]): TempTotals {
  return rows.reduce<TempTotals>(
    (t, r) => ({ count: t.count + 1, tokens: t.tokens + r.tokens, usd: t.usd + r.usd }),
    { count: 0, tokens: 0, usd: 0 });
}

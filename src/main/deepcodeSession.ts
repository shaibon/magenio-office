/** DeepCode session discovery (t-286).
 *
 *  DeepCode's notify hook hands over no session id (only DURATION, STATUS, FAIL_REASON, BODY, TITLE),
 *  so the hive never learned one and hibernation held every deepcode agent at 'no-session'. But the CLI
 *  keeps each thread as `<home>/.deepcode/projects/<project code>/<session id>.jsonl` and resumes it
 *  with `deepcode --resume <id>`; the newest file in an agent's own project dir is the thread it is
 *  running. The project code mirrors the CLI's getProjectCode (legacy: path separators → '-', colons
 *  dropped; over 64 chars: sanitized basename prefix + sha256 of the resolved root). */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const MAX_PROJECT_CODE_LENGTH = 64;
const HASH_LENGTH = 16;
const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function deepcodeProjectCode(projectRoot: string, platform: string = process.platform): string {
  const legacy = projectRoot.replace(/[\\/]/g, '-').replace(/:/g, '');
  if (legacy.length <= MAX_PROJECT_CODE_LENGTH) return legacy;
  const root = resolve(projectRoot);
  const hash = createHash('sha256').update(platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, HASH_LENGTH);
  const prefix = basename(root).replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_PROJECT_CODE_LENGTH - HASH_LENGTH - 1).replace(/[-.]+$/g, '') || 'project';
  return `${prefix}-${hash}`;
}

/** The newest session id for a working directory, or undefined when it has no thread yet. */
export function latestDeepcodeSession(cwd: string, home: string): string | undefined {
  const roots = new Set<string>([cwd]);
  try { roots.add(realpathSync(cwd)); } catch { /* the folder may be gone */ }
  let best: { id: string; at: number } | undefined;
  for (const root of roots) {
    const dir = join(home, '.deepcode', 'projects', deepcodeProjectCode(root));
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const m = SESSION_FILE.exec(n);
      if (!m) continue;
      try {
        const at = statSync(join(dir, n)).mtimeMs;
        if (!best || at > best.at) best = { id: m[1], at };
      } catch { /* vanished */ }
    }
  }
  return best?.id;
}

/** What a DeepCode agent is doing RIGHT NOW (t-296), from the CLI's own files, which it writes during the
 *  turn (its notify hook only fires at the end of one):
 *   - sessions-index.json entry: `status` (processing / waiting_for_user / completed / failed),
 *     cumulative `usage` and `updateTime`, rewritten when a turn starts and after every model response;
 *   - the session `<id>.jsonl`: one row appended per message; a `role:"tool"` row names the tool run
 *     in `meta.function.name`. */
export interface DeepcodeActivity {
  sessionId: string;
  status: string | null;
  updatedAt: number | null;
  totalTokens: number | null;
  lastTool: string | null;
}

const TAIL_BYTES = 256 * 1024;

/** Parsed-file caches keyed on (mtime, size): the fleet timer runs every few seconds for every DeepCode
 *  agent, and an unchanged file must cost one stat, not a parse. */
const fileCache = new Map<string, { sig: string; value: unknown }>();
function cached<T>(file: string, load: () => T): T {
  const st = statSync(file);
  const sig = `${st.mtimeMs}:${st.size}`;
  const hit = fileCache.get(file);
  if (hit && hit.sig === sig) return hit.value as T;
  const value = load();
  fileCache.set(file, { sig, value });
  if (fileCache.size > 512) fileCache.delete(fileCache.keys().next().value as string);
  return value;
}

/** The last tool name in the tail of a session file, or null. Reads only the end; rows are one JSON each. */
export function lastToolInJsonl(file: string): string | null {
  try {
    return cached(file, () => {
      let fd: number | undefined;
      try {
        fd = openSync(file, 'r');
        const size = fstatSync(fd).size;
        const len = Math.min(size, TAIL_BYTES);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, size - len);
        const lines = buf.toString('utf8').split('\n');
        if (size > len) lines.shift(); // first line is cut
        for (let i = lines.length - 1; i >= 0; i--) {
          const l = lines[i].trim();
          if (!l) continue;
          try {
            const r = JSON.parse(l) as { role?: string; meta?: { function?: { name?: unknown } } };
            const name = r.role === 'tool' ? r.meta?.function?.name : undefined;
            if (typeof name === 'string' && name) return name;
          } catch { /* partial or odd row */ }
        }
      } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* noop */ } }
      return null;
    });
  } catch { return null; }
}

interface IndexEntry { id?: string; status?: string; createTime?: string; updateTime?: string; usage?: { total_tokens?: number } }

/** Which session belongs to THIS agent. Only a recorded id, or — for a first turn that has none yet — the
 *  single session created after this process was spawned. Anything ambiguous returns null: a wrong
 *  agent's activity is worse than none (two agents can share a working folder). */
export function pickDeepcodeSession(entries: IndexEntry[], sessionId: string | undefined, spawnedAt: number | undefined): IndexEntry | null {
  if (sessionId) return entries.find((e) => e?.id === sessionId) ?? null;
  if (!spawnedAt) return null;
  const mine = entries.filter((e) => e?.id && Date.parse(e.createTime ?? '') >= spawnedAt - 2000);
  return mine.length === 1 ? mine[0] : null;
}

export function deepcodeActivity(cwd: string, home: string, bind: { sessionId?: string; spawnedAt?: number } = {}): DeepcodeActivity | null {
  const roots = new Set<string>([cwd]);
  try { roots.add(realpathSync(cwd)); } catch { /* gone */ }
  for (const root of roots) {
    const dir = join(home, '.deepcode', 'projects', deepcodeProjectCode(root));
    let entries: IndexEntry[];
    try {
      const idxFile = join(dir, 'sessions-index.json');
      entries = cached(idxFile, () => {
        const idx = JSON.parse(readFileSync(idxFile, 'utf8')) as { entries?: unknown };
        return (Array.isArray(idx.entries) ? idx.entries : Object.values((idx.entries ?? {}) as object)) as IndexEntry[];
      });
    } catch { continue; }
    const e = pickDeepcodeSession(entries, bind.sessionId, bind.spawnedAt);
    if (!e?.id) continue;
    const t = typeof e.updateTime === 'string' ? Date.parse(e.updateTime) : NaN;
    return {
      sessionId: e.id,
      status: typeof e.status === 'string' ? e.status : null,
      updatedAt: Number.isFinite(t) ? t : null,
      totalTokens: typeof e.usage?.total_tokens === 'number' ? e.usage.total_tokens : null,
      lastTool: lastToolInJsonl(join(dir, `${e.id}.jsonl`))
    };
  }
  return null;
}

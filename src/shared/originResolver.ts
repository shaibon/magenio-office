/**
 * Resolves a cwd to its git origin without flooding the main process: results are
 * cached (with a TTL), concurrent asks for one cwd share a single lookup, and at
 * most `limit` lookups run at once. Each lookup spawns `git` in main, so a roster
 * of dozens of agents asked for by several panels at once must not become dozens
 * of simultaneous processes — or be asked for again every time a result lands.
 */
export interface OriginResolver {
  get(cwd: string): Promise<string | null>;
}

export function createOriginResolver(
  lookup: (cwd: string) => Promise<string | null>,
  opts: { limit?: number; ttlMs?: number; now?: () => number } = {}
): OriginResolver {
  const limit = opts.limit ?? 4;
  const ttl = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; p: Promise<string | null> }>();
  const waiting: (() => void)[] = [];
  let running = 0;

  const pump = (): void => {
    while (running < limit && waiting.length) { running++; waiting.shift()!(); }
  };
  const run = (cwd: string): Promise<string | null> => new Promise((resolve) => {
    waiting.push(() => {
      // A failed lookup is a resolved "no origin": one bad cwd never blocks the queue.
      lookup(cwd).catch(() => null).then((o) => { running--; resolve(o); pump(); });
    });
    pump();
  });

  return {
    get(cwd) {
      const hit = cache.get(cwd);
      if (hit && now() - hit.at < ttl) return hit.p;
      const p = run(cwd);
      cache.set(cwd, { at: now(), p });
      return p;
    }
  };
}

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
  // `at` is null while the lookup is in flight: such an entry is always shared, however
  // long it takes (a real git call can sit queued behind others past the TTL). The TTL
  // clock starts when the lookup settles.
  const cache = new Map<string, { at: number | null; p: Promise<string | null> }>();
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
      const t = now();
      // Evict settled entries past their TTL so a long session does not keep every cwd it ever saw.
      for (const [k, e] of cache) if (e.at !== null && t - e.at >= ttl) cache.delete(k);
      const hit = cache.get(cwd);
      if (hit) return hit.p;
      const entry: { at: number | null; p: Promise<string | null> } = { at: null, p: undefined as unknown as Promise<string | null> };
      entry.p = run(cwd).then((o) => { entry.at = now(); return o; });
      cache.set(cwd, entry);
      return entry.p;
    }
  };
}

/** Which registry rows the app-start orphan sweep may archive (t-282).
 *
 *  A normal quit leaves every row `archived:false` with no PTY (quit does not archive). The sweep used
 *  to treat all of them as orphans, so each start archived the whole team (one hive git commit per
 *  agent) and the boot restore then un-archived it. An agent the roster says boot will bring back —
 *  on the floor or in the restorable list, awake or asleep — is not an orphan. Only a row nobody
 *  would restore (no roster entry) is swept. */
export interface SweepFacts {
  godId: string | null | undefined;
  agents: Record<string, { archived?: boolean; crashed?: boolean }>;
  hasLivePty: (id: string) => boolean;
  isSleeper: (id: string) => boolean;
  /** Ids the roster lists as floor or restorable agents; null when the roster could not be read. */
  rosterIds: ReadonlySet<string> | null;
}

export function orphansToArchive(f: SweepFacts): string[] {
  const out: string[] = [];
  for (const [id, a] of Object.entries(f.agents)) {
    if (a.archived) continue;
    if (id === f.godId) continue;          // god is never archived
    if (f.hasLivePty(id)) continue;        // genuinely active
    if (f.isSleeper(id)) continue;         // asleep on purpose
    if (a.crashed) continue;               // died abnormally: stays in the roster, restartable
    // Boot will restore it (awake or asleep). rosterIds only holds restorable-shaped entries, so a junk
    // roster id cannot shield a real orphan. A new agent has no session yet and is still restorable.
    if (f.rosterIds?.has(id)) continue;
    out.push(id);
  }
  return out;
}

/** Agent ids a roster snapshot lists as restorable by the boot restore (floor + restorable entries with a cwd). */
export function restorableRosterIds(snap: { agents?: unknown[]; restorable?: unknown[] } | null | undefined): Set<string> | null {
  if (!snap) return null;
  const ids = new Set<string>();
  for (const list of [snap.agents, snap.restorable]) {
    for (const e of Array.isArray(list) ? list : []) {
      const { id, cwd } = (e ?? {}) as { id?: unknown; cwd?: unknown };
      if (typeof id === 'string' && id && typeof cwd === 'string' && cwd) ids.add(id);
    }
  }
  return ids;
}

/** Rows the roster shields from the sweep that no restore attempt reached: unarchived, no process, not
 *  asleep, not already crashed. Used when the renderer never starts a boot restore. */
export function shieldedButUnrestored(f: SweepFacts): string[] {
  const swept = new Set(orphansToArchive({ ...f, rosterIds: null }));
  const stillSwept = new Set(orphansToArchive(f));
  return [...swept].filter((id) => !stillSwept.has(id));
}

/**
 * t-044 — registry-backed recovery for the renderer's Archived list.
 *
 * registry.json is the durable roster source: every agent the hive has ever
 * spawned is there, archived or not, with its original id and cwd. The
 * renderer's archivedAgents/restorableAgents lists are localStorage caches and
 * can lose an agent that never passed through the floor's archive button.
 *
 * These pure helpers build the recovery ROW SET (no React, no store, no DOM):
 * the Archived list shows the renderer's richer archivedAgents first, then any
 * registry agent that is not already reachable on the floor, in the archived
 * list, or in the restorable dropdown. Registry rows have fewer fields, so the
 * conversion supplies safe display defaults while preserving id + cwd — the two
 * fields respawn needs to reattach memory/inbox/registry.
 */

export interface RegistryRecoverySource {
  id: string;
  name: string;
  provider?: string;
  role?: string;
  cwd: string;
  project?: string;
  isGod?: boolean;
  isAssistant?: boolean;
}

/** A registry-only row with every field the renderer's Agent requires filled
 *  with a safe default. Kept as plain data so node:test can exercise it without
 *  importing the renderer. */
export interface RegistryRecoveryRow {
  id: string;
  name: string;
  provider?: string;
  description: string;
  cwd: string;
  project: string;
  character: string;
  accent: string;
  tmuxTarget: string;
  status: 'idle';
  action: string;
  progress: number;
  archived: true;
  isGod?: boolean;
  isAssistant?: boolean;
}

const CAST_NAMES = new Set([
  'michael', 'jim', 'pam', 'dwight', 'kevin', 'angela', 'oscar',
  'stanley', 'phyllis', 'andy', 'kelly', 'ryan', 'toby', 'creed', 'meredith'
]);

function characterForId(id: string): string {
  const prefix = id.split('-')[0] ?? '';
  return CAST_NAMES.has(prefix) ? prefix : 'jim';
}

/** Registry meta → renderer-safe archived row. `id` and `cwd` are preserved
 *  verbatim — losing either would make the restore start a DIFFERENT agent or
 *  spawn into the wrong workspace. */
export function registryAgentToRecoveryRow(r: RegistryRecoverySource): RegistryRecoveryRow {
  return {
    id: r.id,
    name: r.name,
    provider: r.provider,
    description: r.role?.trim() || r.name,
    cwd: r.cwd,
    project: r.project ?? '',
    character: characterForId(r.id),
    accent: 'sky',
    tmuxTarget: '',
    status: 'idle',
    action: 'archived',
    progress: 0,
    archived: true,
    ...(r.isGod ? { isGod: true } : {}),
    ...(r.isAssistant ? { isAssistant: true } : {})
  };
}

/** Merge renderer archivedAgents (richer, win by id) with registry-only rows.
 *  `alreadyListedIds` = floor agents + restorable-dropdown agents: those are
 *  already reachable and must not get a second, duplicate row here. */
export function mergeRecoveryRows<T extends { id: string }>(
  archived: readonly T[],
  registry: readonly RegistryRecoverySource[],
  alreadyListedIds: Iterable<string>
): Array<T | RegistryRecoveryRow> {
  const alreadyListed = new Set(alreadyListedIds);
  const seen = new Set<string>();
  const rows: Array<T | RegistryRecoveryRow> = [];
  for (const a of archived) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    rows.push(a);
  }
  for (const r of registry) {
    if (alreadyListed.has(r.id) || seen.has(r.id)) continue;
    seen.add(r.id);
    rows.push(registryAgentToRecoveryRow(r));
  }
  return rows;
}

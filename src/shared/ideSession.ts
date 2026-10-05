/**
 * IDE SESSION — the state that travels when the IDE is popped out into its own
 * window and docked back.
 *
 * There is only ever ONE live IDE: popping out closes the embedded panel and
 * opens the window with this snapshot, docking does the reverse. Nothing is
 * shared while both exist, because they never do, so edits cannot diverge. The
 * snapshot carries what cannot be re-read from disk: open tabs, the active one,
 * and the UNSAVED buffers. Everything else (clean file contents, git status,
 * diffs) is reloaded by the receiving side.
 *
 * Pure and import-free so the main process and the renderer share one validator.
 */

export type IdeTabMode = 'edit' | 'diff' | 'revdiff' | 'image';
export type IdeMdView = 'code' | 'split' | 'preview';
export type IdeRailTab = 'changes' | 'history' | 'compare';

export interface IdeSessionTab {
  key: string; rel: string; mode: IdeTabMode;
  revA?: string; revB?: string; revLabel?: string;
}

export interface IdeSession {
  agent: { id: string; name: string; isGod: boolean } | null;
  inferred: boolean;
  root: string | null;
  tabs: IdeSessionTab[];
  activeKey: string | null;
  /** Unsaved edits only, keyed by relative path. */
  dirty: Record<string, { content: string; original: string }>;
  mdViews: Record<string, IdeMdView>;
  treeWidth: number;
  railTab: IdeRailTab;
}

const MAX_TABS = 200;
const MAX_STR = 4096;
const MAX_BUFFER = 20 * 1024 * 1024;
const MODES: IdeTabMode[] = ['edit', 'diff', 'revdiff', 'image'];
const MD_VIEWS: IdeMdView[] = ['code', 'split', 'preview'];
const RAIL_TABS: IdeRailTab[] = ['changes', 'history', 'compare'];

const str = (v: unknown, max = MAX_STR): string | null => (typeof v === 'string' && v.length <= max ? v : null);

/** Validate untrusted input (it crosses an IPC boundary). Returns null when the
 *  shape is unusable; otherwise a clean copy with dangling references dropped. */
export function sanitizeIdeSession(raw: unknown): IdeSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const root = r.root === null ? null : str(r.root);
  if (root === null && r.root !== null) return null;

  let agent: IdeSession['agent'] = null;
  if (r.agent && typeof r.agent === 'object') {
    const a = r.agent as Record<string, unknown>;
    const id = str(a.id), name = str(a.name);
    if (id === null || name === null) return null;
    agent = { id, name, isGod: a.isGod === true };
  }

  const tabs: IdeSessionTab[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(r.tabs) ? r.tabs.slice(0, MAX_TABS) : []) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const key = str(o.key), rel = str(o.rel);
    if (key === null || rel === null || seen.has(key) || !MODES.includes(o.mode as IdeTabMode)) continue;
    seen.add(key);
    const tab: IdeSessionTab = { key, rel, mode: o.mode as IdeTabMode };
    if (o.mode === 'revdiff') {
      const revA = str(o.revA), revB = str(o.revB);
      if (revA === null || revB === null) continue; // unusable without both sides
      tab.revA = revA; tab.revB = revB;
      tab.revLabel = str(o.revLabel) ?? undefined;
    }
    tabs.push(tab);
  }

  const activeKey = typeof r.activeKey === 'string' && seen.has(r.activeKey)
    ? r.activeKey
    : tabs.length ? tabs[tabs.length - 1].key : null;

  // A buffer only matters for a path that still has an edit tab.
  const editRels = new Set(tabs.filter((t) => t.mode === 'edit').map((t) => t.rel));
  const dirty: IdeSession['dirty'] = {};
  if (r.dirty && typeof r.dirty === 'object') {
    for (const [rel, b] of Object.entries(r.dirty as Record<string, unknown>)) {
      if (!editRels.has(rel) || !b || typeof b !== 'object') continue;
      const content = str((b as Record<string, unknown>).content, MAX_BUFFER);
      const original = str((b as Record<string, unknown>).original, MAX_BUFFER);
      if (content !== null && original !== null && content !== original) dirty[rel] = { content, original };
    }
  }

  const mdViews: IdeSession['mdViews'] = {};
  if (r.mdViews && typeof r.mdViews === 'object') {
    for (const [rel, v] of Object.entries(r.mdViews as Record<string, unknown>)) {
      if (rel.length <= MAX_STR && MD_VIEWS.includes(v as IdeMdView)) mdViews[rel] = v as IdeMdView;
    }
  }

  const w = typeof r.treeWidth === 'number' && Number.isFinite(r.treeWidth) ? r.treeWidth : 300;
  return {
    agent, inferred: r.inferred === true, root, tabs, activeKey, dirty, mdViews,
    treeWidth: Math.min(520, Math.max(200, Math.round(w))),
    railTab: RAIL_TABS.includes(r.railTab as IdeRailTab) ? (r.railTab as IdeRailTab) : 'changes'
  };
}

export type IdeCloseAction = 'close' | 'dock' | 'prompt';

/**
 * What to do when the detached IDE window is asked to close. Unsaved buffers are
 * never discarded silently:
 *  - a window to dock into (and the app is not quitting) → dock, which carries the
 *    tabs and the unsaved edits home;
 *  - nowhere to dock (origin gone, or the app is quitting) → ask before discarding
 *    when there is anything unsaved, otherwise just close.
 */
export function ideCloseAction(s: { dirty: boolean; hasTarget: boolean; quitting: boolean }): IdeCloseAction {
  if (s.hasTarget && !s.quitting) return 'dock';
  return s.dirty ? 'prompt' : 'close';
}

/** The unsaved subset of the live edit buffers. */
export function dirtyBuffers(
  buffers: Record<string, { content: string; original: string; status: string }>
): IdeSession['dirty'] {
  const out: IdeSession['dirty'] = {};
  for (const [rel, b] of Object.entries(buffers)) {
    if (b.status === 'ready' && b.content !== b.original) out[rel] = { content: b.content, original: b.original };
  }
  return out;
}

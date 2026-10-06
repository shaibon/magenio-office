// Pure helpers for the Settings → Memory & Knowledge → Vault Sync UI.
// Kept out of SettingsModal.tsx (a JSX file with no unit tests — see
// settings-one-save.test.cjs's own comment on why) so the actual merge/slug
// logic is directly testable instead of only source-scannable.
import type { KnowledgeGraphConfig } from '@/store/config';

/** Compose a `knowledgeGraph` patch against BOTH the saved config and
 *  whatever is already staged in this Settings session, so editing (say)
 *  `vaultSync.enabled` never clobbers an `enabled` toggle staged moments
 *  earlier — `stage()` in SettingsModal replaces the whole `knowledgeGraph`
 *  key on every call, it does not deep-merge it.
 *
 *  `vaultSync` itself merges one level deep, mirroring main's own
 *  `writeConfig` (src/main/config.ts): a patch that omits `vaultSync`
 *  preserves the current one; a patch that DOES include it replaces at that
 *  level (a patched `projects` array replaces, it doesn't element-wise merge). */
export function mergeKnowledgeGraphPatch(
  saved: KnowledgeGraphConfig | undefined,
  staged: KnowledgeGraphConfig | undefined,
  patch: Partial<KnowledgeGraphConfig>
): KnowledgeGraphConfig {
  const current: KnowledgeGraphConfig = { ...(saved ?? {}), ...(staged ?? {}) };
  const next: KnowledgeGraphConfig = { ...current, ...patch };
  if (patch.vaultSync) {
    next.vaultSync = { ...current.vaultSync, ...patch.vaultSync };
  }
  return next;
}

/** Same shape as knowledgeVaultSync.ts's own PROJECT_SLUG_RE — a slug this
 *  module produces must satisfy the backend's own validation, or a mapping
 *  that looked fine in Settings would fail silently at sync time instead. */
const PROJECT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Derive a valid project slug from a folder name (e.g. a registered repo's
 *  basename), so picking a project from the dropdown never requires the
 *  operator to also type a slug by hand. */
export function slugifyProjectName(name: string): string {
  let s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  s = s.slice(0, 40).replace(/-+$/g, '');
  return PROJECT_SLUG_RE.test(s) ? s : 'project';
}

/** Append `-2`, `-3`, … until `slug` no longer collides with `existing` — two
 *  mappings sharing a slug would resolve to the same store directory (see
 *  knowledgeVaultSync.ts's own duplicate-slug guard); this keeps Settings
 *  from ever proposing that in the first place. */
export function dedupeSlug(slug: string, existing: string[]): string {
  if (!existing.includes(slug)) return slug;
  const base = slug.slice(0, 36);
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Where a project's notes go by default: `01-Projects/<Name>`. The folder need not exist yet:
 *  the project's writer agent creates it on its first update. Null when the name leaves nothing usable. */
export function defaultVaultFolder(name: string): string | null {
  const n = name.replace(/[\\/\0]/g, ' ').replace(/^[.\s]+/, '').trim();
  return n ? `01-Projects/${n}` : null;
}

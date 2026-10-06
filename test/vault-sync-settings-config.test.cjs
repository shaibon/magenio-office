'use strict';

// Pure logic behind the Settings → Memory & Knowledge → Vault Sync UI
// (src/renderer/src/components/vaultSyncConfig.ts). Split out of the
// (untested, source-scanned only) SettingsModal.tsx specifically so this
// logic — the staging-merge bug fix, and slug derivation — has real tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { mergeKnowledgeGraphPatch, slugifyProjectName, dedupeSlug } =
  loadTs('src/renderer/src/components/vaultSyncConfig.ts');

test('mergeKnowledgeGraphPatch: an unrelated field staged earlier survives a later patch', () => {
  // The bug this exists to prevent: toggling Knowledge Graph `enabled`, then
  // separately editing `vaultSync`, used to have the second `stage()` call
  // replace the whole `knowledgeGraph` object and silently drop `enabled`.
  const saved = { enabled: false };
  const staged = { enabled: true };
  const next = mergeKnowledgeGraphPatch(saved, staged, { vaultSync: { enabled: true } });
  assert.equal(next.enabled, true, 'the previously staged `enabled` must survive');
  assert.equal(next.vaultSync.enabled, true);
});

test('mergeKnowledgeGraphPatch: vaultSync merges one level deep, preserving fields the patch omits', () => {
  const saved = { enabled: true, vaultSync: { enabled: false, vaultPath: '/vault', projects: [{ slug: 'a', repoOrigin: 'x', vaultFolder: 'A' }] } };
  const next = mergeKnowledgeGraphPatch(saved, undefined, { vaultSync: { enabled: true } });
  assert.equal(next.vaultSync.enabled, true);
  assert.equal(next.vaultSync.vaultPath, '/vault', 'vaultPath must survive a patch that only touches enabled');
  assert.deepEqual(next.vaultSync.projects, [{ slug: 'a', repoOrigin: 'x', vaultFolder: 'A' }]);
});

test('mergeKnowledgeGraphPatch: a patched `projects` array replaces, it does not element-wise merge', () => {
  const saved = { vaultSync: { projects: [{ slug: 'a', repoOrigin: 'x', vaultFolder: 'A' }] } };
  const next = mergeKnowledgeGraphPatch(saved, undefined, { vaultSync: { projects: [] } });
  assert.deepEqual(next.vaultSync.projects, []);
});

test('mergeKnowledgeGraphPatch: a patch with no vaultSync key at all leaves the staged vaultSync untouched', () => {
  const saved = { enabled: false };
  const staged = { enabled: false, vaultSync: { enabled: true, vaultPath: '/v' } };
  const next = mergeKnowledgeGraphPatch(saved, staged, { enabled: true });
  assert.equal(next.enabled, true);
  assert.deepEqual(next.vaultSync, { enabled: true, vaultPath: '/v' });
});

test('slugifyProjectName: lowercases, hyphenates, and strips leading/trailing hyphens', () => {
  assert.equal(slugifyProjectName('Motta BurdaStyle'), 'motta-burdastyle');
  assert.equal(slugifyProjectName('  --Weird__Name!! '), 'weird-name');
});

test('slugifyProjectName: a name with no valid characters falls back to "project"', () => {
  assert.equal(slugifyProjectName('日本語'), 'project');
  assert.equal(slugifyProjectName(''), 'project');
});

test('slugifyProjectName: truncates to 40 chars without leaving a trailing hyphen', () => {
  const s = slugifyProjectName('a'.repeat(39) + '-' + 'b'.repeat(10));
  assert.ok(s.length <= 40, `got length ${s.length}`);
  assert.ok(!s.endsWith('-'), `must not end with a hyphen: "${s}"`);
});

test('dedupeSlug: returns the slug unchanged when there is no collision', () => {
  assert.equal(dedupeSlug('burdastyle', ['other']), 'burdastyle');
});

test('dedupeSlug: appends -2, -3, ... until free', () => {
  assert.equal(dedupeSlug('a', ['a']), 'a-2');
  assert.equal(dedupeSlug('a', ['a', 'a-2']), 'a-3');
});

test('defaultVaultFolder proposes 01-Projects/<Name>, no matter whether it exists yet', () => {
  const { defaultVaultFolder } = loadTs('src/renderer/src/components/vaultSyncConfig.ts');
  assert.equal(defaultVaultFolder('growshopitalia'), '01-Projects/growshopitalia');
  assert.equal(defaultVaultFolder('Bindi Giochi'), '01-Projects/Bindi Giochi');
  assert.equal(defaultVaultFolder('../x/y'), '01-Projects/x y');
  assert.equal(defaultVaultFolder('  '), null);
});

'use strict';

/**
 * t-044 — registry.json is the durable roster source; the renderer's archived /
 * restorable lists are lossy localStorage caches. An agent that never passed
 * through archiveAgent() on the floor can be missing from BOTH renderer lists,
 * so the Archived section must recover it from the registry.
 *
 * These are runtime tests for the PURE shared helpers (no React/Electron), plus
 * source-wiring checks that the Command Center actually uses the merged rows
 * and the existing restore path.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { registryAgentToRecoveryRow, mergeRecoveryRows } = loadTs('src/shared/registryRecovery.ts');

test('registryAgentToRecoveryRow preserves the original id and cwd', () => {
  const row = registryAgentToRecoveryRow({
    id: 'dwight-mtcttd07',
    name: 'Dwight',
    provider: 'codex',
    cwd: '/Users/shaibon/HarnessAgents/worktrees/dwight-mtcttd07',
    project: 'BURD'
  });
  assert.equal(row.id, 'dwight-mtcttd07');
  assert.equal(row.cwd, '/Users/shaibon/HarnessAgents/worktrees/dwight-mtcttd07');
});

test('registryAgentToRecoveryRow fills missing renderer fields so a sparse row still renders', () => {
  const row = registryAgentToRecoveryRow({
    id: 'worker-abc',
    name: 'Worker',
    cwd: '/tmp/worker'
    // no role, no provider, no project, no character/accent/description
  });
  assert.equal(row.description, 'Worker', 'role fallback should be the name');
  assert.equal(row.character, 'jim', 'unknown id prefix should get the default cast member');
  assert.equal(row.accent, 'sky', 'missing accent should get a safe default');
  assert.equal(row.project, '', 'missing project should be empty, not undefined');
  assert.equal(row.archived, true);
  assert.equal(row.status, 'idle');
  assert.equal(typeof row.tmuxTarget, 'string');
  assert.equal(row.action, 'archived');
});

test('registryAgentToRecoveryRow derives a recognizable character from the id prefix', () => {
  assert.equal(registryAgentToRecoveryRow({
    id: 'pam-mtctnhm3', name: 'Pam', cwd: '/x'
  }).character, 'pam');
  assert.equal(registryAgentToRecoveryRow({
    id: 'stanley-mtiqrngk', name: 'Stanley', cwd: '/x'
  }).character, 'stanley');
});

test('mergeRecoveryRows: an agent present ONLY in the registry is included', () => {
  const registry = [{ id: 'only-reg', name: 'Lost', cwd: '/lost' }];
  const rows = mergeRecoveryRows([], registry, []);
  assert.deepEqual(rows.map((r) => r.id), ['only-reg']);
});

test('mergeRecoveryRows: no duplicate when an agent is in BOTH renderer archived and registry', () => {
  const archived = [{ id: 'a1', name: 'Renderer copy', cwd: '/a' }];
  const registry = [
    { id: 'a1', name: 'Registry copy', cwd: '/a' },
    { id: 'a2', name: 'Registry only', cwd: '/b' }
  ];
  const rows = mergeRecoveryRows(archived, registry, []);
  assert.deepEqual(rows.map((r) => r.id), ['a1', 'a2']);
  assert.equal(rows[0].name, 'Renderer copy', 'renderer copy must win when both sources have the id');
});

test('mergeRecoveryRows: agents already on the floor or in the restorable dropdown are not duplicated', () => {
  const registry = [
    { id: 'live', name: 'Live', cwd: '/live' },
    { id: 'restorable', name: 'Restorable', cwd: '/rest' },
    { id: 'truly-missing', name: 'Missing', cwd: '/missing' }
  ];
  const rows = mergeRecoveryRows([], registry, ['live', 'restorable']);
  assert.deepEqual(rows.map((r) => r.id), ['truly-missing']);
});

test('CommandCenter Archived section maps the merged recovery rows, not just the renderer cache', () => {
  const cc = read('src/renderer/src/components/CommandCenterPanel.tsx');
  assert.match(cc, /const rows = useRegistryArchivedAgents\(\);/,
    'ArchivedSection does not use the registry-backed rows');
  assert.match(cc, /rows\.map\(\(a\) => \{/,
    'ArchivedSection does not render the merged rows');
  assert.match(cc, /restoreArchivedAgent\(a, config\)/,
    'a registry-recovered row has no restore path — clicking cannot bring it back');
});

test('registry hook fetches hiveRegistry once and excludes floor + restorable ids', () => {
  const hook = read('src/renderer/src/hooks/useRegistryArchivedAgents.ts');
  assert.match(hook, /window\.cth\.hiveRegistry\(\)/,
    'the hook never reads registry.json');
  assert.match(hook, /mergeRecoveryRows\(archivedAgents, registryEntries \?\? \[\], alreadyListedIds\)/,
    'the hook no longer merges through the shared helper');
  assert.match(hook, /for \(const a of agents\) alreadyListedIds\.add\(a\.id\)/,
    'live floor agents are not excluded from the archived recovery list');
  assert.match(hook, /for \(const a of restorableAgents\) alreadyListedIds\.add\(a\.id\)/,
    'restorable dropdown agents are not excluded from the archived recovery list');
});

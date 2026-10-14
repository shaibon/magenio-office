'use strict';
// t-189: a purged agent (worktree gone) must not be resurrected by the boot
// auto-restore of a stale roster entry.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { HiveManager } = loadTs('src/main/hive.ts');

test('setArchived parks a registry row so a missing-cwd agent stays off the roster', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ghost-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'g1', name: 'G', provider: 'codex', cwd: home });
  hive.setArchived('g1', true);
  const reg = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'registry.json'), 'utf8'));
  assert.equal(reg.agents.g1.archived, true);
  hive.setArchived('nope', true); // unknown id: no-op, no throw
});

test('spawn core refuses a missing cwd BEFORE ensureAgent (wiring)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const guard = src.indexOf('cwdIsDir(opts.cwd)');
  const ensure = src.indexOf('hive.ensureAgent(', guard);
  assert.ok(guard > 0 && ensure > guard, 'cwd guard must precede hive.ensureAgent in spawnAgentCore');
  assert.match(src, /error: `cwd-missing: /);
});

test('restore treats cwd-missing as a dropped ghost, not a retryable failure (wiring)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/hooks/useRestoreTeam.ts'), 'utf8');
  assert.match(src, /startsWith\('cwd-missing'\)/);
  assert.equal((src.match(/outcome\.kind === 'gone'/g) || []).length >= 2, true);
});

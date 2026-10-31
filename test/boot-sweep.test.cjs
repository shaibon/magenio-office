'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { orphansToArchive, restorableRosterIds } = loadTs('src/main/bootSweep.ts');

const facts = (over) => ({
  godId: 'god', agents: {}, hasLivePty: () => false, isSleeper: () => false, rosterIds: new Set(), ...over
});

test('a boot with N registry agents and no PTYs archives none of the restorable ones', () => {
  const agents = { god: {} };
  const roster = { agents: [], restorable: [] };
  for (let i = 0; i < 68; i++) {
    agents[`a${i}`] = {};
    (i % 2 ? roster.agents : roster.restorable).push({ id: `a${i}` });
  }
  assert.deepEqual(orphansToArchive(facts({ agents, rosterIds: restorableRosterIds(roster) })), []);
});

test('a real orphan with no roster entry is still swept; god, live, asleep, crashed, archived are not', () => {
  const agents = {
    god: {}, ghost: {}, kept: {}, live: {}, asleep: {}, crashed: { crashed: true }, old: { archived: true }
  };
  const out = orphansToArchive(facts({
    agents,
    rosterIds: new Set(['kept']),
    hasLivePty: (id) => id === 'live',
    isSleeper: (id) => id === 'asleep'
  }));
  assert.deepEqual(out, ['ghost']);
});

test('an unreadable roster falls back to the old sweep (restore un-archives anyway)', () => {
  assert.deepEqual(orphansToArchive(facts({ agents: { a: {}, b: {} }, rosterIds: restorableRosterIds(null) })), ['a', 'b']);
});

test('roster ids come from floor and restorable entries; junk entries are ignored', () => {
  const ids = restorableRosterIds({ agents: [{ id: 'x' }, null, { id: 5 }, {}], restorable: [{ id: 'y' }] });
  assert.deepEqual([...ids].sort(), ['x', 'y']);
});

test('archiveOrphanedAgents is wired through the roster-aware rule, and quit itself archives nothing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(src, /orphansToArchive\(\{[\s\S]{0,600}restorableRosterIds\(roster\.read\(\)\)/);
  const pty = fs.readFileSync(path.join(__dirname, '..', 'src/main/pty.ts'), 'utf8');
  assert.match(pty, /killAll\(\) \{\s*this\.exitHandler = null;/, 'killAll suppresses the exit teardown');
});

test('after the restore: a row whose restore failed, or a hostile roster entry, is swept again', () => {
  // Failed restore (restorable entry kept for the retry UI) and a poisoned entry shielding a real orphan.
  const agents = { pam: {}, evil: {}, restored: {} };
  const roster = { restorable: [{ id: 'pam', name: 'Pam', cwd: '/valid', command: '' }], agents: [{ id: 'evil' }, { id: 'restored' }] };
  const during = orphansToArchive(facts({ agents, rosterIds: restorableRosterIds(roster) }));
  assert.deepEqual(during, [], 'shielded while boot is still restoring');
  const after = orphansToArchive(facts({ agents, rosterIds: null, hasLivePty: (id) => id === 'restored' }));
  assert.deepEqual(after, ['pam', 'evil'], 'only the live one survives the post-restore sweep');
});

test('the post-restore sweep is wired: renderer call after the batch, plus a main fallback timer', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  assert.match(main, /rosterIds: opts\.afterRestore \? null : restorableRosterIds\(roster\.read\(\)\)/);
  assert.match(main, /ipcMain\.handle\('hive:reconcileAfterRestore'[^\n]*archiveOrphanedAgents\(\{ afterRestore: true \}\)/);
  assert.match(main, /setTimeout\(\(\) => archiveOrphanedAgents\(\{ afterRestore: true \}\), 120_000\)/);
  const hook = fs.readFileSync(path.join(root, 'src/renderer/src/hooks/useRestoreTeam.ts'), 'utf8');
  assert.match(hook, /restoring = false;\s*void window\.cth\.reconcileAfterRestore/);
});

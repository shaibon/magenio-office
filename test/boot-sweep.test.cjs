'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { orphansToArchive, restorableRosterIds, shieldedButUnrestored } = loadTs('src/main/bootSweep.ts');

const facts = (over) => ({
  godId: 'god', agents: {}, hasLivePty: () => false, isSleeper: () => false, rosterIds: new Set(), ...over
});

test('a boot with N registry agents and no PTYs archives none of the restorable ones', () => {
  const agents = { god: {} };
  const roster = { agents: [], restorable: [] };
  for (let i = 0; i < 68; i++) {
    agents[`a${i}`] = { sessionId: `s${i}` };
    (i % 2 ? roster.agents : roster.restorable).push({ id: `a${i}`, cwd: '/w', command: 'claude' });
  }
  assert.deepEqual(orphansToArchive(facts({ agents, rosterIds: restorableRosterIds(roster) })), []);
});

test('a real orphan with no roster entry is still swept; god, live, asleep, crashed, archived are not', () => {
  const agents = {
    god: {}, ghost: {}, kept: { sessionId: 's' }, live: {}, asleep: {}, crashed: { crashed: true }, old: { archived: true }
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
  const ids = restorableRosterIds({ agents: [{ id: 'x', cwd: '/w' }, null, { id: 5, cwd: '/w' }, {}], restorable: [{ id: 'y', cwd: '/w' }, { id: 'nocwd' }] });
  assert.deepEqual([...ids].sort(), ['x', 'y']);
});

test('archiveOrphanedAgents is wired through the roster-aware rule, and quit itself archives nothing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(src, /orphansToArchive\(\{[\s\S]{0,300}restorableRosterIds\(roster\.read\(\)\)/);
  const pty = fs.readFileSync(path.join(__dirname, '..', 'src/main/pty.ts'), 'utf8');
  assert.match(pty, /killAll\(\) \{\s*this\.exitHandler = null;/, 'killAll suppresses the exit teardown');
});

test('a new agent with no session yet stays shielded; a junk roster id (no cwd) cannot shield an orphan', () => {
  const agents = { pam: {}, evil: {} };
  const rosterIds = restorableRosterIds({ agents: [{ id: 'evil' }], restorable: [{ id: 'pam', name: 'Pam', cwd: '/valid', command: 'claude' }] });
  assert.deepEqual(orphansToArchive(facts({ agents, rosterIds })), ['evil']);
});

test('when no restore ever starts, shielded rows that nothing attempted are the ones to mark', () => {
  const agents = { pam: {}, lone: {}, up: {}, done: { crashed: true } };
  const rosterIds = new Set(['pam', 'up', 'done']);
  const f = facts({ agents, rosterIds, hasLivePty: (id) => id === 'up' });
  assert.deepEqual(shieldedButUnrestored(f), ['pam']);
});

test('the no-restore fallback waits for an in-flight batch and the renderer reports its batch', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  assert.match(main, /bootRestoreState === 'running' && attempt < 10\) \{ setTimeout/);
  assert.match(main, /bootRestoreState = running === true \? 'running' : 'done';\s*if \(bootRestoreState === 'done'\) markUnrestoredAfterBoot\(\)/);
  assert.match(main, /markUnrestoredAfterBoot\(\), 180_000/);
  const hook = fs.readFileSync(path.join(root, 'src/renderer/src/hooks/useRestoreTeam.ts'), 'utf8');
  assert.match(hook, /restoring = true;\s*void window\.cth\.restoreBatch\?\.\(true\)/);
  assert.match(hook, /restoring = false;\s*void window\.cth\.restoreBatch\?\.\(false\)/);
});

test('a failed boot restore keeps the row (crashed), and mail to a crashed row bounces like an archived one', () => {
  const root = path.join(__dirname, '..');
  const hive = fs.readFileSync(path.join(root, 'src/main/hive.ts'), 'utf8');
  assert.match(hive, /markRestoreFailed\(id: string\)[\s\S]{0,400}a\.crashed = true/);
  assert.match(hive, /reg\.agents\[t\]\?\.crashed \? 'not running \(crashed\)'/);
  assert.match(hive, /if \(t !== godId && deadState\) \{/);
  const hook = fs.readFileSync(path.join(root, 'src/renderer/src/hooks/useRestoreTeam.ts'), 'utf8');
  assert.match(hook, /failures\.push\(outcome\.error\);[\s\S]{0,200}markRestoreFailed/);
  assert.match(fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8'), /hive:markRestoreFailed[\s\S]{0,200}hive\.markRestoreFailed\(id\)/);
  assert.deepEqual(orphansToArchive(facts({ agents: { pam: { crashed: true } }, rosterIds: null })), []);
});

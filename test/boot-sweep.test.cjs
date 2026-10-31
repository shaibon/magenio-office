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
    agents[`a${i}`] = { sessionId: `s${i}` };
    (i % 2 ? roster.agents : roster.restorable).push({ id: `a${i}` });
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
  const ids = restorableRosterIds({ agents: [{ id: 'x' }, null, { id: 5 }, {}], restorable: [{ id: 'y' }] });
  assert.deepEqual([...ids].sort(), ['x', 'y']);
});

test('archiveOrphanedAgents is wired through the roster-aware rule, and quit itself archives nothing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(src, /orphansToArchive\(\{[\s\S]{0,300}restorableRosterIds\(roster\.read\(\)\)/);
  const pty = fs.readFileSync(path.join(__dirname, '..', 'src/main/pty.ts'), 'utf8');
  assert.match(pty, /killAll\(\) \{\s*this\.exitHandler = null;/, 'killAll suppresses the exit teardown');
});

test('a junk roster id (no registry session) cannot shield a real orphan; a hibernated session counts', () => {
  const agents = { pam: {}, evil: {}, sleepy: { hibernated: { sessionId: 'h' } } };
  const rosterIds = restorableRosterIds({ agents: [{ id: 'evil' }, { id: 'pam' }, { id: 'sleepy' }] });
  assert.deepEqual(orphansToArchive(facts({ agents, rosterIds })), ['pam', 'evil']);
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

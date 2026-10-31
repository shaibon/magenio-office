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
  assert.match(src, /orphansToArchive\(\{[\s\S]{0,300}restorableRosterIds\(roster\.read\(\)\)/);
  const pty = fs.readFileSync(path.join(__dirname, '..', 'src/main/pty.ts'), 'utf8');
  assert.match(pty, /killAll\(\) \{\s*this\.exitHandler = null;/, 'killAll suppresses the exit teardown');
});

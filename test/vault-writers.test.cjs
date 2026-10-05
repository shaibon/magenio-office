'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { eligibleWriters, writerChips, addWriter, removeWriter } = loadTs('src/shared/vaultWriters.ts');

const O = 'git@x:burd.git';
const ag = (id, origin, archived = false) => ({ id, name: id.toUpperCase(), origin, archived });
const agents = [ag('angela', O), ag('dwight', O), ag('old', O, true), ag('vai', 'git@x:vai.git'), ag('pending', null)];

test('options: live agents of this project only, minus those already chosen', () => {
  assert.deepEqual(eligibleWriters(O, [], agents).map((a) => a.id), ['angela', 'dwight']);
  assert.deepEqual(eligibleWriters(O, ['angela'], agents).map((a) => a.id), ['dwight']);
  assert.deepEqual(eligibleWriters('', [], agents), []); // project not picked yet
});

test('chips flag unknown, archived and other-project ids; unresolved origin is not judged', () => {
  const chips = writerChips(O, ['angela', 'ghost', 'old', 'vai', 'pending'], agents);
  assert.deepEqual(chips.map((c) => c.state), ['ok', 'unknown', 'archived', 'otherProject', 'ok']);
  assert.equal(chips[1].name, 'ghost'); // unknown shows its raw id
});

test('add is idempotent, remove drops only that id', () => {
  assert.deepEqual(addWriter(['a'], 'a'), ['a']);
  assert.deepEqual(addWriter(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(removeWriter(['a', 'b'], 'a'), ['b']);
});

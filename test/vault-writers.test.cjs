'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { eligibleWriters, writerChips, addWriter, removeWriter } = loadTs('src/shared/vaultWriters.ts');

const O = 'git@x:burd.git';
const ag = (id, origin, archived = false) => ({ id, name: id.toUpperCase(), origin, archived });
const agents = [ag('angela', O), ag('dwight', O), ag('old', O, true), ag('vai', 'git@x:vai.git'), ag('pending', undefined), ag('norepo', null)];

test('options: live agents of this project only, minus those already chosen', () => {
  assert.deepEqual(eligibleWriters(O, [], agents).map((a) => a.id), ['angela', 'dwight']);
  assert.deepEqual(eligibleWriters(O, ['angela'], agents).map((a) => a.id), ['dwight']);
  assert.deepEqual(eligibleWriters('', [], agents), []); // project not picked yet
});

test('chips flag unknown, archived and other-project ids; origin still loading is not judged, resolved-to-nothing is flagged', () => {
  const chips = writerChips(O, ['angela', 'ghost', 'old', 'vai', 'pending', 'norepo'], agents);
  assert.deepEqual(chips.map((c) => c.state), ['ok', 'unknown', 'archived', 'otherProject', 'ok', 'noOrigin']);
  assert.equal(chips[1].name, 'ghost'); // unknown shows its raw id
});

test('add is idempotent, remove drops only that id', () => {
  assert.deepEqual(addWriter(['a'], 'a'), ['a']);
  assert.deepEqual(addWriter(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(removeWriter(['a', 'b'], 'a'), ['b']);
});

test('real registry shape: two Angelas per project are distinct, labelled, unique and sorted first', () => {
  const { writerLabel, projectAgrees } = loadTs('src/shared/vaultWriters.ts');
  const role = 'Documentation curator — keeps the README accurate, clear, and grounded strictly in the code';
  const B = 'git@bitbucket.org:magenio/bravifarmacie.git', D = 'git@bitbucket.org:magenio/burdastyle.git';
  const mk = (id, name, origin, project, r = role) => ({ id, name, origin, archived: false, project, role: r });
  const roster = [
    mk('dwight-1', 'Dwight', B, 'BRAVI', 'Developer — builds features'),
    mk('angela-mtidlh62', 'Angela', B, 'BRAVI'),
    mk('angela-muvdk1xn', 'Angela', B, 'BRAVI'),
    mk('angela-mtiqsow0', 'Angela', D, 'BURD'),
    mk('angela-muvdjjel', 'Angela', D, 'BURD'),
    mk('angela-muvdjjel', 'Angela', D, 'BURD') // the same id twice (stale + fresh copy)
  ];
  const opts = eligibleWriters(B, [], roster, ['BRAVI']);
  assert.deepEqual(opts.map((a) => a.id), ['angela-mtidlh62', 'angela-muvdk1xn', 'dwight-1']); // Angelas first
  assert.equal(writerLabel(opts[1]), 'Angela · Documentation curator · angela-muvdk1xn');
  assert.equal(new Set(opts.map(writerLabel)).size, opts.length); // all distinguishable
  assert.deepEqual(eligibleWriters(D, [], roster).map((a) => a.id), ['angela-mtiqsow0', 'angela-muvdjjel']); // deduped by id
  // origin matches but the roster project disagrees with the mapping's project => excluded / flagged
  const odd = [mk('angela-x', 'Angela', B, 'VAI')];
  assert.equal(eligibleWriters(B, [], odd, ['BRAVI']).length, 0);
  assert.equal(writerChips(B, ['angela-x'], odd, ['BRAVI'])[0].state, 'otherProject');
  // no known keys, or no roster project => not judged
  assert.equal(projectAgrees(odd[0], []), true);
  assert.equal(projectAgrees({ ...odd[0], project: '' }, ['BRAVI']), true);
});

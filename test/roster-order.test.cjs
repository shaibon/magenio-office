'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { applyOrder, moveKey, parseKeys } = loadTs('src/renderer/src/components/rosterOrder.ts');

test('applyOrder: saved first, stale dropped, new appended', () => {
  assert.deepEqual(applyOrder(['a', 'b', 'c'], ['c', 'x', 'a', 'c']), ['c', 'a', 'b']);
  assert.deepEqual(applyOrder(['a', 'b'], []), ['a', 'b']);
});
test('moveKey: moves into target slot, unknown is a no-op', () => {
  assert.deepEqual(moveKey(['a', 'b', 'c'], 'a', 'c'), ['b', 'c', 'a']);
  assert.deepEqual(moveKey(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  const o = ['a', 'b'];
  assert.equal(moveKey(o, 'a', 'zz'), o);
});
test('parseKeys: tolerant', () => {
  assert.deepEqual(parseKeys('["a",1,"b"]'), ['a', 'b']);
  assert.deepEqual(parseKeys('{bad'), []);
  assert.deepEqual(parseKeys(null), []);
});

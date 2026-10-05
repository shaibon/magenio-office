'use strict';

// The snapshot that moves between the embedded IDE and its own window.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { sanitizeIdeSession, dirtyBuffers } = loadTs('src/shared/ideSession.ts');

const good = () => ({
  agent: { id: 'a1', name: 'Dwight', isGod: false }, inferred: false, root: '/w/a1',
  tabs: [
    { key: 'edit::a.ts', rel: 'a.ts', mode: 'edit' },
    { key: 'diff::a.ts', rel: 'a.ts', mode: 'diff' },
    { key: 'rev::x::y::b.ts', rel: 'b.ts', mode: 'revdiff', revA: 'x', revB: 'y', revLabel: 'x…y' }
  ],
  activeKey: 'diff::a.ts',
  dirty: { 'a.ts': { content: 'new', original: 'old' } },
  mdViews: { 'README.md': 'preview' }, treeWidth: 340, railTab: 'history'
});

test('a valid session round-trips unchanged', () => {
  assert.deepEqual(sanitizeIdeSession(good()), good());
});

test('unsaved buffers survive; clean or orphaned ones are dropped', () => {
  const s = good();
  s.dirty['gone.ts'] = { content: 'x', original: 'y' };       // no tab
  s.dirty['a.ts'] = { content: 'same', original: 'same' };     // not dirty
  assert.deepEqual(sanitizeIdeSession(s).dirty, {});
});

test('dangling active tab falls back to the last tab; junk tabs are skipped', () => {
  const s = good();
  s.activeKey = 'nope';
  s.tabs.push({ key: 'edit::a.ts', rel: 'a.ts', mode: 'edit' }, { key: 'k', rel: 'r', mode: 'weird' }, { key: 'rev', rel: 'r', mode: 'revdiff' }, null);
  const out = sanitizeIdeSession(s);
  assert.equal(out.tabs.length, 3);
  assert.equal(out.activeKey, 'rev::x::y::b.ts');
});

test('bounds and enums are clamped; non-objects and bad roots rejected', () => {
  const s = good();
  s.treeWidth = 99999; s.railTab = 'nope'; s.mdViews = { 'a.md': 'bogus' };
  const out = sanitizeIdeSession(s);
  assert.equal(out.treeWidth, 520);
  assert.equal(out.railTab, 'changes');
  assert.deepEqual(out.mdViews, {});
  for (const bad of [null, 'x', 42, { ...good(), root: 5 }, { ...good(), agent: { id: 1, name: 'x' } }]) assert.equal(sanitizeIdeSession(bad), null);
  assert.equal(sanitizeIdeSession({ ...good(), root: null }).root, null);
});

test('dirtyBuffers keeps only ready, modified buffers', () => {
  assert.deepEqual(dirtyBuffers({
    a: { content: '2', original: '1', status: 'ready' },
    b: { content: '1', original: '1', status: 'ready' },
    c: { content: '', original: '', status: 'loading' },
    d: { content: 'x', original: 'y', status: 'error' }
  }), { a: { content: '2', original: '1' } });
});

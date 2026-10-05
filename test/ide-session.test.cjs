'use strict';

// The snapshot that moves between the embedded IDE and its own window.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { sanitizeIdeSession, dirtyBuffers, ideCloseAction } = loadTs('src/shared/ideSession.ts');

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

test('closing the IDE window never drops unsaved edits silently', () => {
  const act = (dirty, hasTarget, quitting) => ideCloseAction({ dirty, hasTarget, quitting });
  // A window to dock into: dock, clean or dirty (tabs and edits go home).
  assert.equal(act(true, true, false), 'dock');
  assert.equal(act(false, true, false), 'dock');
  // Origin gone with no survivor: ask if anything is unsaved, else just close.
  assert.equal(act(true, false, false), 'prompt');
  assert.equal(act(false, false, false), 'close');
  // Quitting: the windows are all going away, so never dock; prompt if dirty.
  assert.equal(act(true, true, true), 'prompt');
  assert.equal(act(true, false, true), 'prompt');
  assert.equal(act(false, true, true), 'close');
});

test('main wires the decision into every exit path (no silent destroy, no quit bypass)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/main/index.ts'), 'utf8');
  assert.doesNotMatch(src, /ideWin!\.destroy\(\)/);                       // origin close no longer destroys the IDE
  assert.doesNotMatch(src, /if \(ideForceClose \|\| allowQuit\) return/);    // quit no longer skips the snapshot
  assert.match(src, /ideCloseAction\(\{ dirty: ideDirty, hasTarget: !!ideDockTarget\(\), quitting: allowQuit \}\)/);
  assert.match(src, /if \(allowQuit\) return null;/);                       // no dock target while quitting
  assert.match(src, /promptDiscardIde\(\)/);
});
